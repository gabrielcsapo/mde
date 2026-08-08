import Foundation
import MDEditorUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Draws the host's own block and inline types. Content that is fully described by the
/// markdown itself belongs here; anything that has to be fetched belongs in
/// `DiskResourceResolver`.
public final class HostWidgets: WidgetProvider {
    public init() {}

    public func makeWidget(roleName: String, source: String, payload: String?) -> PlatformView? {
        switch roleName {
        case "callout":
            // `payload` is the fence argument — "warning" in ```callout warning.
            CardView(text: Self.fenceBody(source), tone: payload == "warning" ? .warning : .info)
        case "chart":
            // For a directive block the payload is the body itself.
            CardView(text: "📊 " + (payload ?? ""), tone: .info)
        case "mention":
            ChipView(text: source)
        default:
            nil
        }
    }

    public func widgetSize(roleName: String, source: String, fittingWidth: CGFloat) -> CGSize? {
        switch roleName {
        case "callout":
            CGSize(width: fittingWidth, height: CardView.height(for: Self.fenceBody(source), width: fittingWidth))
        case "chart":
            CGSize(width: fittingWidth, height: CardView.height(for: source, width: fittingWidth))
        case "mention":
            ChipView.size(for: source)
        default:
            nil
        }
    }

    /// Strip the ``` fence lines, keep the body.
    static func fenceBody(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .dropFirst()
            .filter { !$0.hasPrefix("```") }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public final class CardView: PlatformView {
    public enum Tone { case info, warning }

    private static let font = PlatformFont.platformSystem(ofSize: 15)
    private static let inset = CGSize(width: 14, height: 12)

    private let label: PlatformLabel

    public init(text: String, tone: Tone) {
        // A wrapping label is its own kind of NSTextField, not a configured one.
        //
        // Setting `maximumNumberOfLines = 0`, `lineBreakMode`, `wraps` and
        // `isScrollable` on a plain `NSTextField()` is not enough: AppKit still routes
        // it through its single-line fast path (`NSTextFieldSimpleLabel`), which measures
        // as multi-line — `intrinsicContentSize` reports two lines — but *draws* one line
        // and clips it. The measurements all look right while the callout renders cut
        // off, which is what made this hard to see. This factory is the supported way to
        // get a label that actually wraps.
        #if os(macOS)
        label = PlatformLabel(wrappingLabelWithString: text)
        #else
        label = PlatformLabel()
        #endif
        super.init(frame: .zero)
        let accent: PlatformColor = tone == .warning ? .systemOrange : .systemBlue

        #if os(macOS)
        // The factory makes it selectable, which would let it swallow clicks meant for
        // the caret (DESIGN §4).
        label.isSelectable = false
        label.maximumNumberOfLines = 0
        label.font = Self.font
        label.textColor = .platformLabel
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.borderWidth = 1
        layer?.backgroundColor = accent.withAlphaComponent(0.12).cgColor
        layer?.borderColor = accent.withAlphaComponent(0.4).cgColor
        #else
        label.text = text
        label.numberOfLines = 0
        label.font = Self.font
        label.textColor = .platformLabel
        layer.cornerRadius = 10
        layer.borderWidth = 1
        backgroundColor = accent.withAlphaComponent(0.12)
        layer.borderColor = accent.withAlphaComponent(0.4).cgColor
        #endif

        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor, constant: Self.inset.height),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Self.inset.height),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.inset.width),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset.width),
        ])
    }

    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("not supported") }

    /// Tell the label how wide it is allowed to be before it wraps.
    ///
    /// Pinning it to the card's edges sets its *frame*, which is not the same thing: a
    /// multi-line label lays its text out against `preferredMaxLayoutWidth`, and at the
    /// default of 0 it measures as a single unbroken line and is then simply clipped by
    /// the frame. The symptom is a callout that draws one cut-off line inside a box
    /// correctly sized for two.
    private func updateWrapWidth() {
        let available = max(bounds.width - Self.inset.width * 2, 0)
        guard label.preferredMaxLayoutWidth != available else { return }
        label.preferredMaxLayoutWidth = available
        label.invalidateIntrinsicContentSize()
        // Re-measuring is not re-drawing: the label keeps its rendered single-line
        // content until it is told the drawing is stale too.
        #if os(macOS)
        label.needsDisplay = true
        #else
        label.setNeedsDisplay()
        #endif
    }

    #if os(macOS)
    override public func layout() {
        super.layout()
        updateWrapWidth()
    }
    #else
    override public func layoutSubviews() {
        super.layoutSubviews()
        updateWrapWidth()
    }
    #endif

    #if os(macOS)
    /// Measures with the same cell that draws, kept warm because sizing runs on every
    /// layout pass. Main-thread only, which is where text layout already lives.
    private static let sizer: NSTextField = {
        let label = NSTextField(wrappingLabelWithString: "")
        label.isSelectable = false
        label.maximumNumberOfLines = 0
        label.font = font
        return label
    }()
    #endif

    /// The height this card needs at a given column width.
    ///
    /// This has to agree with what the label will *draw*, not merely approximate it.
    /// `boundingRect` under-measured by a couple of points, so the attachment reserved a
    /// box very slightly shorter than the text needed — and AppKit's label, given less
    /// room than its `cellSize`, drops to a single line rather than clipping the second.
    /// A callout then rendered as one cut-off line inside a box sized for two, from a
    /// 2pt discrepancy. Measuring through the cell removes the class of bug.
    public static func height(for text: String, width: CGFloat) -> CGFloat {
        let available = max(width - inset.width * 2, 40)
        #if os(macOS)
        sizer.stringValue = text
        let probe = NSRect(x: 0, y: 0, width: available, height: .greatestFiniteMagnitude)
        let size = sizer.cell?.cellSize(forBounds: probe) ?? .zero
        return ceil(size.height) + inset.height * 2
        #else
        let bounds = (text as NSString).boundingRect(
            with: CGSize(width: available, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        )
        return ceil(bounds.height) + inset.height * 2
        #endif
    }
}

public final class ChipView: PlatformView {
    private static let font = PlatformFont.platformSystem(ofSize: 15, weight: .medium)

    public init(text: String) {
        super.init(frame: .zero)
        let label = PlatformLabel()
        #if os(macOS)
        label.stringValue = text
        label.isEditable = false
        label.isBordered = false
        label.drawsBackground = false
        label.font = Self.font
        label.textColor = .systemBlue
        wantsLayer = true
        layer?.cornerRadius = 9
        layer?.backgroundColor = PlatformColor.systemBlue.withAlphaComponent(0.15).cgColor
        #else
        label.text = text
        label.font = Self.font
        label.textColor = .systemBlue
        layer.cornerRadius = 9
        backgroundColor = PlatformColor.systemBlue.withAlphaComponent(0.15)
        #endif

        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 7),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -7),
        ])
    }

    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("not supported") }

    public static func size(for text: String) -> CGSize {
        let w = (text as NSString).size(withAttributes: [.font: font]).width
        return CGSize(width: ceil(w) + 14, height: 22)
    }
}
