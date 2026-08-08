import Foundation

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Parsed display data for a GFM table. The source remains in NSTextStorage; this is
/// only the native projection installed by the table's block attachment.
struct MarkdownTableModel {
    let rows: [[String]]
    let alignments: [NSTextAlignment]

    init?(source: String) {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.count >= 2 else { return nil }
        let header = Self.cells(in: lines[0])
        let delimiter = Self.cells(in: lines[1])
        guard !header.isEmpty, delimiter.count == header.count,
              delimiter.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).range(
                  of: #"^:?-{3,}:?$"#, options: .regularExpression
              ) != nil })
        else { return nil }

        var parsed = [header]
        for line in lines.dropFirst(2) where !line.trimmingCharacters(in: .whitespaces).isEmpty {
            var row = Self.cells(in: line)
            if row.count < header.count {
                row.append(contentsOf: repeatElement("", count: header.count - row.count))
            }
            parsed.append(Array(row.prefix(header.count)))
        }
        rows = parsed
        alignments = delimiter.map { marker in
            let value = marker.trimmingCharacters(in: .whitespaces)
            if value.hasPrefix(":") && value.hasSuffix(":") { return .center }
            if value.hasSuffix(":") { return .right }
            return .left
        }
    }

    private static func cells(in line: String) -> [String] {
        var cells = [String]()
        var cell = ""
        var escaped = false
        for character in line.trimmingCharacters(in: .whitespaces) {
            if escaped {
                cell.append(character)
                escaped = false
            } else if character == "\\" {
                cell.append(character)
                escaped = true
            } else if character == "|" {
                cells.append(cell)
                cell = ""
            } else {
                cell.append(character)
            }
        }
        cells.append(cell)
        if cells.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeFirst() }
        if cells.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { cells.removeLast() }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

/// Turns CommonMark inline content inside one cell into native attributed content.
/// Foundation supplies the inline parse; the renderer maps its presentation intents
/// onto the same fonts and colours as the rest of the editor.
enum TableCellRenderer {
    private static let intentKey = NSAttributedString.Key("NSInlinePresentationIntent")
    private static let imageKey = NSAttributedString.Key("NSImageURL")

    static func render(_ source: String, header: Bool) -> NSAttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let parsed = (try? AttributedString(markdown: source, options: options))
            ?? AttributedString(source)
        let result = NSMutableAttributedString(attributedString: NSAttributedString(parsed))
        let baseFont = PlatformFont.platformSystem(ofSize: 14, weight: header ? .semibold : .regular)
        result.addAttributes(
            [.font: baseFont, .foregroundColor: PlatformColor.platformLabel],
            range: NSRange(location: 0, length: result.length)
        )

        var images = [(NSRange, String)]()
        result.enumerateAttributes(in: NSRange(location: 0, length: result.length)) { attrs, range, _ in
            if let raw = attrs[intentKey] as? NSNumber {
                let value = raw.intValue
                #if os(macOS)
                var traits: NSFontDescriptor.SymbolicTraits = []
                #else
                var traits: UIFontDescriptor.SymbolicTraits = []
                #endif
                if value & 1 != 0 { traits.insert(PlatformFont.platformItalicTrait) }
                if value & 2 != 0 { traits.insert(PlatformFont.platformBoldTrait) }
                if !traits.isEmpty { result.addAttribute(.font, value: baseFont.withTraits(traits), range: range) }
                if value & 4 != 0 {
                    result.addAttributes(
                        [.font: PlatformFont.platformMono(ofSize: 13),
                         .backgroundColor: PlatformColor.platformSecondaryBackground],
                        range: range
                    )
                }
                if value & 32 != 0 {
                    result.addAttribute(
                        .strikethroughStyle,
                        value: NSUnderlineStyle.single.rawValue,
                        range: range
                    )
                }
            }
            if attrs[.link] != nil {
                result.addAttributes(
                    [.foregroundColor: PlatformColor.platformAccent,
                     .underlineStyle: NSUnderlineStyle.single.rawValue],
                    range: range
                )
            }
            if let reference = attrs[imageKey] {
                images.append((range, String(describing: reference)))
            }
        }

        // Mixed text-and-image cells retain an accessible inline fallback. A cell that
        // consists of an image is promoted to a real resolved thumbnail by
        // TableImageCellView below.
        for (range, reference) in images.reversed() {
            let alt = (result.string as NSString).substring(with: range)
            let replacement = NSMutableAttributedString(attachment: imageAttachment())
            replacement.append(NSAttributedString(
                string: " \(alt)",
                attributes: [
                    .font: baseFont,
                    .foregroundColor: PlatformColor.platformAccent,
                    imageKey: reference,
                ]
            ))
            result.replaceCharacters(in: range, with: replacement)
        }
        return result
    }

    private static func imageAttachment() -> NSTextAttachment {
        let attachment = NSTextAttachment()
        #if os(macOS)
        attachment.image = NSImage(systemSymbolName: "photo", accessibilityDescription: "Image")
        #else
        attachment.image = UIImage(systemName: "photo")
        #endif
        attachment.bounds = CGRect(x: 0, y: -2, width: 14, height: 14)
        return attachment
    }
}

struct TableImageSpec {
    let alt: String
    let reference: String

    init?(source: String) {
        let pattern = #"^!\[([^\]]*)\]\(([^\s\)]+)(?:\s+[^\)]*)?\)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(
                in: source,
                range: NSRange(location: 0, length: (source as NSString).length)
              ),
              match.range.location != NSNotFound
        else { return nil }
        let value = source as NSString
        alt = value.substring(with: match.range(at: 1))
        reference = value.substring(with: match.range(at: 2))
    }
}

/// A real resource thumbnail inside a native table cell. It snapshots the cached
/// resolved view instead of re-parenting it, so the same reference can also appear as
/// a full-size image elsewhere in the document without either projection stealing it.
final class TableImageCellView: PlatformView {
    static let maximumWidthForLayout: CGFloat = 96
    private let alignment: NSTextAlignment
    private var content: PlatformView!
    private var thumbnailSize = CGSize(width: 64, height: 36)

    init(spec: TableImageSpec, alignment: NSTextAlignment, fittingWidth: CGFloat, resources: ResourceCache?) {
        self.alignment = alignment
        super.init(frame: .zero)
        let width = min(Self.maximumWidthForLayout, max(fittingWidth, 36))
        thumbnailSize = CGSize(width: width, height: floor(width * 9 / 16))
        let request = ResourceRequest(
            reference: spec.reference,
            roleName: "image",
            source: "![\(spec.alt)](\(spec.reference))",
            fittingWidth: width
        )
        if let resources, case .ready(let resolved) = resources.state(for: request),
           let image = resolved.snapshotImage() {
            content = Self.imageView(image)
        } else {
            content = Self.placeholder(spec.alt)
        }
        addSubview(content)
        #if os(macOS)
        identifier = NSUserInterfaceItemIdentifier("mde.table-image")
        #else
        accessibilityIdentifier = "mde.table-image"
        isAccessibilityElement = true
        accessibilityLabel = spec.alt
        #endif
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    private static func imageView(_ image: PlatformImage) -> PlatformView {
        #if os(macOS)
        let view = NSImageView(image: image)
        view.imageScaling = .scaleAxesIndependently
        view.wantsLayer = true
        view.layer?.cornerRadius = 6
        view.layer?.masksToBounds = true
        #else
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFill
        view.layer.cornerRadius = 6
        view.clipsToBounds = true
        #endif
        return view
    }

    private static func placeholder(_ alt: String) -> PlatformView {
        #if os(macOS)
        let label = NSTextField(labelWithString: alt)
        label.alignment = .center
        label.textColor = .secondaryLabelColor
        label.wantsLayer = true
        label.layer?.backgroundColor = NSColor.underPageBackgroundColor.cgColor
        label.layer?.cornerRadius = 6
        #else
        let label = UILabel()
        label.text = alt
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.backgroundColor = .secondarySystemBackground
        label.layer.cornerRadius = 6
        label.clipsToBounds = true
        #endif
        return label
    }

    #if os(macOS)
    override var isFlipped: Bool { true }
    override func layout() { super.layout(); layoutContent() }
    #else
    override func layoutSubviews() { super.layoutSubviews(); layoutContent() }
    #endif

    private func layoutContent() {
        let width = min(thumbnailSize.width, bounds.width)
        let size = CGSize(width: width, height: min(thumbnailSize.height, bounds.height))
        let x: CGFloat = switch alignment {
        case .right: bounds.width - size.width
        case .center: (bounds.width - size.width) / 2
        default: 0
        }
        content.frame = CGRect(x: max(0, x), y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
    }
}

private extension PlatformView {
    func snapshotImage() -> PlatformImage? {
        #if os(macOS)
        if let image = (self as? NSImageView)?.image { return image }
        for subview in subviews {
            if let image = subview.snapshotImage() { return image }
        }
        layoutSubtreeIfNeeded()
        guard bounds.width > 0, bounds.height > 0,
              let bitmap = bitmapImageRepForCachingDisplay(in: bounds)
        else { return nil }
        cacheDisplay(in: bounds, to: bitmap)
        let image = NSImage(size: bounds.size)
        image.addRepresentation(bitmap)
        return image
        #else
        if let image = (self as? UIImageView)?.image { return image }
        for subview in subviews {
            if let image = subview.snapshotImage() { return image }
        }
        layoutIfNeeded()
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        return UIGraphicsImageRenderer(bounds: bounds).image { context in
            layer.render(in: context.cgContext)
        }
        #endif
    }
}

/// Native grid view shared by UIKit and AppKit. Equal columns keep the projection
/// stable across platforms; row height expands for wrapped or formatted cell content.
final class TableWidgetView: PlatformView {
    private static let horizontalInset: CGFloat = 12
    private static let verticalInset: CGFloat = 9
    private static let minimumRowHeight: CGFloat = 40
    private static let rule: CGFloat = 1

    let model: MarkdownTableModel
    private let cells: [PlatformView]
    private let rowBackgrounds: [PlatformView]
    private let rules: [PlatformView]
    private var targetSize: CGSize

    init?(source: String, fittingWidth: CGFloat, resources: ResourceCache? = nil) {
        guard let model = MarkdownTableModel(source: source) else { return nil }
        self.model = model
        targetSize = Self.size(for: model, fittingWidth: fittingWidth)

        let columnWidth = fittingWidth / CGFloat(max(model.rows[0].count, 1))
        var cells = [PlatformView]()
        for (rowIndex, row) in model.rows.enumerated() {
            for (column, cell) in row.enumerated() {
                if let image = TableImageSpec(source: cell) {
                    cells.append(TableImageCellView(
                        spec: image,
                        alignment: model.alignments[column],
                        fittingWidth: max(columnWidth - Self.horizontalInset * 2, 36),
                        resources: resources
                    ))
                    continue
                }
                let content = TableCellRenderer.render(cell, header: rowIndex == 0)
                #if os(macOS)
                let label = NSTextField(wrappingLabelWithString: "")
                label.attributedStringValue = content
                label.isEditable = false
                label.isSelectable = false
                label.isBordered = false
                label.drawsBackground = false
                label.maximumNumberOfLines = 0
                label.alignment = model.alignments[column]
                #else
                let label = UILabel()
                label.attributedText = content
                label.numberOfLines = 0
                label.textAlignment = model.alignments[column]
                label.isAccessibilityElement = true
                #endif
                cells.append(label)
            }
        }
        self.cells = cells
        rowBackgrounds = model.rows.indices.map { _ in PlatformView(frame: .zero) }
        rules = (0..<(max(0, model.rows.count - 1) + max(0, model.rows[0].count - 1)))
            .map { _ in PlatformView(frame: .zero) }

        super.init(frame: CGRect(origin: .zero, size: targetSize))
        #if os(macOS)
        identifier = NSUserInterfaceItemIdentifier("mde.rendered-table")
        wantsLayer = true
        layer?.backgroundColor = PlatformColor.platformBackground.cgColor
        layer?.borderColor = PlatformColor.platformTertiaryLabel.withAlphaComponent(0.35).cgColor
        #else
        accessibilityIdentifier = "mde.rendered-table"
        backgroundColor = .platformBackground
        layer.borderColor = PlatformColor.platformTertiaryLabel.withAlphaComponent(0.35).cgColor
        #endif
        #if os(macOS)
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        layer?.masksToBounds = true
        #else
        layer.cornerRadius = 10
        layer.borderWidth = 1
        layer.masksToBounds = true
        #endif

        for (index, background) in rowBackgrounds.enumerated() {
            #if os(macOS)
            background.wantsLayer = true
            background.layer?.backgroundColor = (index == 0
                ? PlatformColor.platformSecondaryBackground
                : index.isMultiple(of: 2)
                    ? PlatformColor.platformSecondaryBackground.withAlphaComponent(0.38)
                    : PlatformColor.clear).cgColor
            #else
            background.backgroundColor = index == 0
                ? .platformSecondaryBackground
                : index.isMultiple(of: 2)
                    ? PlatformColor.platformSecondaryBackground.withAlphaComponent(0.38)
                    : .clear
            #endif
            addSubview(background)
        }
        for rule in rules {
            #if os(macOS)
            rule.wantsLayer = true
            rule.layer?.backgroundColor = PlatformColor.platformTertiaryLabel
                .withAlphaComponent(0.24).cgColor
            #else
            rule.backgroundColor = PlatformColor.platformTertiaryLabel.withAlphaComponent(0.24)
            #endif
            addSubview(rule)
        }
        cells.forEach(addSubview)
        layoutGrid()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    static func size(for source: String, fittingWidth: CGFloat) -> CGSize {
        guard let model = MarkdownTableModel(source: source) else {
            return CGSize(width: max(fittingWidth, 1), height: minimumRowHeight)
        }
        return size(for: model, fittingWidth: fittingWidth)
    }

    private static func size(for model: MarkdownTableModel, fittingWidth: CGFloat) -> CGSize {
        let width = fittingWidth > 1 ? fittingWidth : 320
        let columnWidth = width / CGFloat(max(model.rows[0].count, 1))
        let rowHeights = model.rows.enumerated().map { rowIndex, row in
            rowHeight(row, header: rowIndex == 0, columnWidth: columnWidth)
        }
        return CGSize(
            width: width,
            height: rowHeights.reduce(0) { $0 + max($1, minimumRowHeight) }
        )
    }

    override var intrinsicContentSize: CGSize { targetSize }

    private func layoutGrid() {
        let columns = max(model.rows[0].count, 1)
        let columnWidth = bounds.width / CGFloat(columns)
        var y: CGFloat = 0
        var cellIndex = 0
        var horizontalRule = 0
        for (rowIndex, row) in model.rows.enumerated() {
            let rowHeight = Self.rowHeight(
                row,
                header: rowIndex == 0,
                columnWidth: columnWidth
            )
            rowBackgrounds[rowIndex].frame = CGRect(x: 0, y: y, width: bounds.width, height: rowHeight)
            for column in 0..<columns {
                cells[cellIndex].frame = CGRect(
                    x: CGFloat(column) * columnWidth + Self.horizontalInset,
                    y: y + Self.verticalInset,
                    width: max(columnWidth - Self.horizontalInset * 2, 1),
                    height: max(rowHeight - Self.verticalInset * 2, 1)
                )
                cellIndex += 1
            }
            y += rowHeight
            if rowIndex < model.rows.count - 1 {
                rules[horizontalRule].frame = CGRect(
                    x: 0, y: y - Self.rule / 2, width: bounds.width, height: Self.rule
                )
                horizontalRule += 1
            }
        }
        for column in 1..<columns {
            rules[horizontalRule].frame = CGRect(
                x: CGFloat(column) * columnWidth - Self.rule / 2,
                y: 0,
                width: Self.rule,
                height: y
            )
            horizontalRule += 1
        }
        targetSize = CGSize(width: bounds.width, height: y)
    }

    private static func rowHeight(_ row: [String], header: Bool, columnWidth: CGFloat) -> CGFloat {
        row.map { cell in
            if TableImageSpec(source: cell) != nil {
                let width = min(TableImageCellView.maximumWidthForLayout, max(columnWidth - horizontalInset * 2, 36))
                return ceil(width * 9 / 16) + verticalInset * 2
            }
            let content = TableCellRenderer.render(cell, header: header)
            let bounds = content.boundingRect(
                with: CGSize(
                    width: max(columnWidth - horizontalInset * 2, 20),
                    height: .greatestFiniteMagnitude
                ),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                context: nil
            )
            return ceil(bounds.height) + verticalInset * 2
        }.max().map { max($0, minimumRowHeight) } ?? minimumRowHeight
    }

    #if os(macOS)
    override var isFlipped: Bool { true }
    override func layout() {
        super.layout()
        layoutGrid()
    }
    #else
    override func layoutSubviews() {
        super.layoutSubviews()
        layoutGrid()
    }
    #endif
}
