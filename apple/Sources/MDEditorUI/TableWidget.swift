import Foundation
import MDECore

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// One core-produced decoration projected into a table cell's local UTF-16 space.
/// The native renderer never parses Markdown: cell boundaries, inline roles and
/// resource destinations all come from Rust.
struct TableInlineDecoration {
    let range: NSRange
    let role: UInt32
    let kind: DecorationKind
    let payload: String?
}

struct TableCellModel {
    let source: String
    let inlines: [TableInlineDecoration]

    var imageOnly: TableImageSpec? {
        let length = (source as NSString).length
        guard let image = inlines.first(where: {
            $0.kind == .inlineWidget && $0.role == Role.image
                && $0.range == NSRange(location: 0, length: length)
        }), let reference = image.payload else { return nil }
        return TableImageSpec(alt: Self.imageAlt(in: source), reference: reference, source: source)
    }

    private static func imageAlt(in source: String) -> String {
        guard source.hasPrefix("!["), let close = source.firstIndex(of: "]") else { return "Image" }
        return String(source[source.index(source.startIndex, offsetBy: 2)..<close])
    }
}

/// Display data assembled exclusively from Rust decorations. The source remains in
/// NSTextStorage; this is only the native projection installed by the table attachment.
struct MarkdownTableModel {
    let rows: [[TableCellModel]]
    let alignments: [NSTextAlignment]

    init?(
        source: String,
        tableRange: NSRange,
        decorations: [Decoration],
        alignmentPayload: String?,
        payload: (UInt64) -> String?
    ) {
        let source = source as NSString
        let cells = decorations
            .filter { $0.role == Role.tableCell && $0.kind == .style }
            .sorted { $0.range.location < $1.range.location }
        guard !cells.isEmpty else { return nil }
        let inlineCandidates = decorations.filter {
            $0.role != Role.table
                && $0.role != Role.tableCell
                && $0.role != Role.tableHeader
                && $0.role != Role.tableDelimiter
        }.sorted { left, right in
            left.range.location == right.range.location
                ? left.range.upperBound < right.range.upperBound
                : left.range.location < right.range.location
        }

        var lineStarts = [0]
        for offset in 0..<source.length where source.character(at: offset) == 10 {
            lineStarts.append(offset + 1)
        }
        func lineIndex(at offset: Int) -> Int {
            var low = 0
            var high = lineStarts.count
            while low < high {
                let middle = (low + high) / 2
                if lineStarts[middle] <= offset { low = middle + 1 } else { high = middle }
            }
            return max(0, low - 1)
        }

        var rowsByLine = [Int: [TableCellModel]]()
        var inlineCursor = 0
        for cell in cells {
            let local = NSRange(
                location: cell.range.location - tableRange.location,
                length: cell.range.length
            )
            guard local.location >= 0, local.upperBound <= source.length else { continue }
            let raw = source.substring(with: local) as NSString
            let content = raw.rangeOfCharacter(from: CharacterSet.whitespacesAndNewlines.inverted)
            let trimmed: NSRange
            if content.location == NSNotFound {
                trimmed = NSRange(location: local.location, length: 0)
            } else {
                let last = raw.rangeOfCharacter(
                    from: CharacterSet.whitespacesAndNewlines.inverted,
                    options: NSString.CompareOptions.backwards
                )
                trimmed = NSRange(
                    location: local.location + content.location,
                    length: last.location + last.length - content.location
                )
            }
            let global = NSRange(
                location: tableRange.location + trimmed.location,
                length: trimmed.length
            )
            while inlineCursor < inlineCandidates.count,
                  inlineCandidates[inlineCursor].range.upperBound <= global.location {
                inlineCursor += 1
            }
            var inline = [TableInlineDecoration]()
            var candidate = inlineCursor
            while candidate < inlineCandidates.count,
                  inlineCandidates[candidate].range.location < global.upperBound {
                let decoration = inlineCandidates[candidate]
                if decoration.range.location >= global.location,
                   decoration.range.upperBound <= global.upperBound {
                    inline.append(TableInlineDecoration(
                        range: NSRange(
                            location: decoration.range.location - global.location,
                            length: decoration.range.length
                        ),
                        role: decoration.role,
                        kind: decoration.kind,
                        payload: payload(decoration.key)
                    ))
                }
                candidate += 1
            }
            let model = TableCellModel(source: source.substring(with: trimmed), inlines: inline)
            rowsByLine[lineIndex(at: trimmed.location), default: []].append(model)
        }
        guard let first = rowsByLine.keys.min(), let header = rowsByLine[first], !header.isEmpty else {
            return nil
        }
        let columns = header.count
        rows = rowsByLine.keys.sorted().map { line in
            var row = rowsByLine[line] ?? []
            if row.count < columns {
                row.append(contentsOf: repeatElement(
                    TableCellModel(source: "", inlines: []),
                    count: columns - row.count
                ))
            }
            return Array(row.prefix(columns))
        }
        let encoded = Array(alignmentPayload ?? "")
        alignments = (0..<columns).map { column in
            switch column < encoded.count ? encoded[column] : "n" {
            case "c": return .center
            case "r": return .right
            default: return .left
            }
        }
    }
}

/// Applies core inline roles to a native attributed string. This deliberately does not
/// invoke Foundation's Markdown parser; Rust has already made every semantic decision.
enum TableCellRenderer {
    static func render(
        _ cell: TableCellModel,
        header: Bool,
        resources: ResourceCache? = nil
    ) -> NSAttributedString {
        let source = cell.source as NSString
        let baseFont = PlatformFont.platformSystem(ofSize: 14, weight: header ? .semibold : .regular)
        let result = NSMutableAttributedString()
        var cuts = Set([0, source.length])
        for inline in cell.inlines {
            cuts.insert(inline.range.location)
            cuts.insert(inline.range.upperBound)
        }
        let points = cuts.filter { $0 >= 0 && $0 <= source.length }.sorted()
        var emittedImages = Set<Int>()
        var startsAt = [Int: [Int]]()
        var endsAt = [Int: [Int]]()
        var active = Set<Int>()
        for (inlineIndex, inline) in cell.inlines.enumerated() {
            guard inline.range.upperBound > 0, inline.range.location < source.length else { continue }
            if inline.range.location <= 0 {
                active.insert(inlineIndex)
            } else {
                startsAt[inline.range.location, default: []].append(inlineIndex)
            }
            if inline.range.upperBound < source.length {
                endsAt[inline.range.upperBound, default: []].append(inlineIndex)
            }
        }
        for index in 0..<max(points.count - 1, 0) {
            let range = NSRange(location: points[index], length: points[index + 1] - points[index])
            guard range.length > 0 else { continue }
            for ending in endsAt[range.location] ?? [] { active.remove(ending) }
            for starting in startsAt[range.location] ?? [] { active.insert(starting) }
            let covering = active.sorted().map { cell.inlines[$0] }
            if let image = covering.first(where: { $0.kind == .inlineWidget && $0.role == Role.image }) {
                if emittedImages.insert(image.range.location).inserted {
                    result.append(NSAttributedString(attachment: imageAttachment(
                        reference: image.payload,
                        source: source.substring(with: image.range),
                        resources: resources
                    )))
                }
                continue
            }
            if covering.contains(where: { $0.kind == .conceal }) { continue }

            var attributes: [NSAttributedString.Key: Any] = [
                .font: baseFont,
                .foregroundColor: PlatformColor.platformLabel,
            ]
            #if os(macOS)
            var traits: NSFontDescriptor.SymbolicTraits = []
            #else
            var traits: UIFontDescriptor.SymbolicTraits = []
            #endif
            for inline in covering where inline.kind == .style {
                switch inline.role {
                case Role.emphasis: traits.insert(PlatformFont.platformItalicTrait)
                case Role.strong: traits.insert(PlatformFont.platformBoldTrait)
                case Role.strikethrough:
                    attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                case Role.codeInline:
                    attributes[.font] = PlatformFont.platformMono(ofSize: 13)
                    attributes[.backgroundColor] = PlatformColor.platformSecondaryBackground
                case Role.linkText:
                    attributes[.foregroundColor] = PlatformColor.platformAccent
                    attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                    if let destination = inline.payload {
                        attributes[.link] = URL(string: destination) ?? destination
                    }
                default: break
                }
            }
            if !traits.isEmpty {
                let font = attributes[.font] as? PlatformFont ?? baseFont
                attributes[.font] = font.withTraits(traits)
            }
            result.append(NSAttributedString(string: source.substring(with: range), attributes: attributes))
        }
        return result
    }

    private static func imageAttachment(
        reference: String?,
        source: String,
        resources: ResourceCache?
    ) -> NSTextAttachment {
        let attachment = NSTextAttachment()
        // Mixed cells need to leave room for adjacent text in a three-column
        // phone layout. Image-only cells use the larger TableImageCellView.
        let width: CGFloat = 40
        if let reference, let resources,
           case .ready(let view) = resources.state(for: ResourceRequest(
            reference: reference,
            roleName: "image",
            source: source,
            fittingWidth: width
           )), let image = view.snapshotImage() {
            attachment.image = image
            attachment.bounds = CGRect(x: 0, y: -3, width: width, height: width * 9 / 16)
        } else {
            #if os(macOS)
            attachment.image = NSImage(systemSymbolName: "photo", accessibilityDescription: "Image")
            #else
            attachment.image = UIImage(systemName: "photo")
            #endif
            attachment.bounds = CGRect(x: 0, y: -2, width: 14, height: 14)
        }
        return attachment
    }
}

#if os(macOS)
/// Selectable native text gives links pointer, keyboard, and VoiceOver interaction.
final class TableTextCellView: NSTextView, NSTextViewDelegate {
    private let onOpenLink: ((String) -> Void)?

    init(content: NSAttributedString, alignment: NSTextAlignment, onOpenLink: ((String) -> Void)?) {
        self.onOpenLink = onOpenLink
        let storage = NSTextStorage()
        let layoutManager = NSLayoutManager()
        let container = NSTextContainer()
        storage.addLayoutManager(layoutManager)
        layoutManager.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        storage.setAttributedString(content)
        isEditable = false
        isSelectable = true
        drawsBackground = false
        textContainerInset = .zero
        textContainer?.lineFragmentPadding = 0
        textContainer?.widthTracksTextView = true
        isVerticallyResizable = true
        isHorizontallyResizable = false
        self.alignment = alignment
        delegate = self
        identifier = NSUserInterfaceItemIdentifier("mde.table-cell")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        guard let destination = Self.destination(link) else { return false }
        onOpenLink?(destination)
        return onOpenLink != nil
    }

    @discardableResult
    func activateLink(at index: Int) -> Bool {
        guard index >= 0, index < attributedString().length,
              let link = attributedString().attribute(.link, at: index, effectiveRange: nil),
              let destination = Self.destination(link)
        else { return false }
        onOpenLink?(destination)
        return onOpenLink != nil
    }

    private static func destination(_ value: Any) -> String? {
        if let url = value as? URL { return url.absoluteString }
        return value as? String
    }
}
#else
/// Selectable native text gives links touch, keyboard, and VoiceOver interaction.
final class TableTextCellView: UITextView, UITextViewDelegate {
    private let onOpenLink: ((String) -> Void)?

    init(content: NSAttributedString, alignment: NSTextAlignment, onOpenLink: ((String) -> Void)?) {
        self.onOpenLink = onOpenLink
        super.init(frame: .zero, textContainer: nil)
        attributedText = content
        isEditable = false
        isSelectable = true
        isScrollEnabled = false
        backgroundColor = .clear
        textContainerInset = .zero
        textContainer.lineFragmentPadding = 0
        self.textAlignment = alignment
        delegate = self
        accessibilityIdentifier = "mde.table-cell"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    func textView(
        _ textView: UITextView,
        primaryActionFor textItem: UITextItem,
        defaultAction: UIAction
    ) -> UIAction? {
        guard case .link(let url) = textItem.content else { return defaultAction }
        return UIAction { [weak self] _ in self?.onOpenLink?(url.absoluteString) }
    }

    @discardableResult
    func activateLink(at index: Int) -> Bool {
        guard index >= 0, index < attributedText.length,
              let value = attributedText.attribute(.link, at: index, effectiveRange: nil)
        else { return false }
        let destination = (value as? URL)?.absoluteString ?? value as? String
        guard let destination else { return false }
        onOpenLink?(destination)
        return onOpenLink != nil
    }
}
#endif

/// Lightweight cells avoid constructing a complete TextKit stack per table value.
/// A 100×10 table used to allocate one text view, text storage, layout manager, and
/// text container for every plain cell even though only cells with links need native
/// text interaction.
final class TableLabelCellView: PlatformLabel {
    init(content: NSAttributedString, alignment: NSTextAlignment) {
        #if os(macOS)
        super.init(frame: .zero)
        attributedStringValue = content
        isEditable = false
        isSelectable = false
        isBezeled = false
        drawsBackground = false
        lineBreakMode = .byWordWrapping
        maximumNumberOfLines = 0
        self.alignment = alignment
        identifier = NSUserInterfaceItemIdentifier("mde.table-cell")
        #else
        super.init(frame: .zero)
        attributedText = content
        numberOfLines = 0
        lineBreakMode = .byWordWrapping
        textAlignment = alignment
        accessibilityIdentifier = "mde.table-cell"
        #endif
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }
}

struct TableImageSpec {
    let alt: String
    let reference: String
    let source: String
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
            source: spec.source,
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

    init(
        model: MarkdownTableModel,
        fittingWidth: CGFloat,
        resources: ResourceCache? = nil,
        onOpenLink: ((String) -> Void)? = nil
    ) {
        self.model = model
        targetSize = Self.size(for: model, fittingWidth: fittingWidth)

        let columnWidth = fittingWidth / CGFloat(max(model.rows[0].count, 1))
        var cells = [PlatformView]()
        for (rowIndex, row) in model.rows.enumerated() {
            for (column, cell) in row.enumerated() {
                if let image = cell.imageOnly {
                    cells.append(TableImageCellView(
                        spec: image,
                        alignment: model.alignments[column],
                        fittingWidth: max(columnWidth - Self.horizontalInset * 2, 36),
                        resources: resources
                    ))
                    continue
                }
                let content = TableCellRenderer.render(
                    cell,
                    header: rowIndex == 0,
                    resources: resources
                )
                let hasLink = {
                    var found = false
                    content.enumerateAttribute(
                        .link,
                        in: NSRange(location: 0, length: content.length)
                    ) { value, _, stop in
                        if value != nil { found = true; stop.pointee = true }
                    }
                    return found
                }()
                if hasLink {
                    cells.append(TableTextCellView(
                        content: content,
                        alignment: model.alignments[column],
                        onOpenLink: onOpenLink
                    ))
                } else {
                    cells.append(TableLabelCellView(
                        content: content,
                        alignment: model.alignments[column]
                    ))
                }
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
            #else
            rule.backgroundColor = PlatformColor.platformTertiaryLabel.withAlphaComponent(0.24)
            #endif
            addSubview(rule)
        }
        cells.forEach(addSubview)
        #if os(macOS)
        updateAppearanceColors()
        #endif
        layoutGrid()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    static func size(for model: MarkdownTableModel, fittingWidth: CGFloat) -> CGSize {
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

    private static func rowHeight(_ row: [TableCellModel], header: Bool, columnWidth: CGFloat) -> CGFloat {
        row.map { cell in
            if cell.imageOnly != nil {
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
    private func updateAppearanceColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = PlatformColor.platformBackground.cgColor
            layer?.borderColor = PlatformColor.platformTertiaryLabel
                .withAlphaComponent(0.35).cgColor
            for (index, background) in rowBackgrounds.enumerated() {
                background.layer?.backgroundColor = (index == 0
                    ? PlatformColor.platformSecondaryBackground
                    : index.isMultiple(of: 2)
                        ? PlatformColor.platformSecondaryBackground.withAlphaComponent(0.38)
                        : PlatformColor.clear).cgColor
            }
            for rule in rules {
                rule.layer?.backgroundColor = PlatformColor.platformTertiaryLabel
                    .withAlphaComponent(0.24).cgColor
            }
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateAppearanceColors()
    }

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
