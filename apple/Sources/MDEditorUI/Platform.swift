// UIKit and AppKit differ in type names far more than in behaviour for what this
// renderer needs: attributed strings, text storage, TextKit 2, and attachments are the
// same API on both. Aliasing the handful of divergent types keeps the decoration
// logic in one place instead of two copies that drift.

#if os(macOS)
import AppKit

public typealias PlatformFont = NSFont
public typealias PlatformColor = NSColor
public typealias PlatformView = NSView
public typealias PlatformImage = NSImage
public typealias PlatformEdgeInsets = NSEdgeInsets
public typealias PlatformLabel = NSTextField

extension NSFont {
    public static func platformSystem(ofSize size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: size, weight: weight)
    }
    public static var platformBody: NSFont { NSFont.preferredFont(forTextStyle: .body) }
    public static func platformMono(ofSize size: CGFloat) -> NSFont {
        NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }
    func withTraits(_ traits: NSFontDescriptor.SymbolicTraits) -> NSFont {
        let d = fontDescriptor.withSymbolicTraits(traits)
        return NSFont(descriptor: d, size: pointSize) ?? self
    }
    public static var platformBoldTrait: NSFontDescriptor.SymbolicTraits { .bold }
    public static var platformItalicTrait: NSFontDescriptor.SymbolicTraits { .italic }
}

extension NSColor {
    public static var platformLabel: NSColor { .labelColor }
    public static var platformSecondaryLabel: NSColor { .secondaryLabelColor }
    public static var platformTertiaryLabel: NSColor { .tertiaryLabelColor }
    public static var platformAccent: NSColor { .controlAccentColor }
    public static var platformSecondaryBackground: NSColor { .underPageBackgroundColor }
    public static var platformBackground: NSColor { .textBackgroundColor }
}

#else
import UIKit

public typealias PlatformFont = UIFont
public typealias PlatformColor = UIColor
public typealias PlatformView = UIView
public typealias PlatformImage = UIImage
public typealias PlatformEdgeInsets = UIEdgeInsets
public typealias PlatformLabel = UILabel

extension UIFont {
    public static func platformSystem(ofSize size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        UIFont.systemFont(ofSize: size, weight: weight)
    }
    public static var platformBody: UIFont { UIFont.preferredFont(forTextStyle: .body) }
    public static func platformMono(ofSize size: CGFloat) -> UIFont {
        UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let d = fontDescriptor.withSymbolicTraits(traits) else { return self }
        return UIFont(descriptor: d, size: pointSize)
    }
    public static var platformBoldTrait: UIFontDescriptor.SymbolicTraits { .traitBold }
    public static var platformItalicTrait: UIFontDescriptor.SymbolicTraits { .traitItalic }
}

extension UIColor {
    public static var platformLabel: UIColor { .label }
    public static var platformSecondaryLabel: UIColor { .secondaryLabel }
    public static var platformTertiaryLabel: UIColor { .tertiaryLabel }
    public static var platformAccent: UIColor { .systemBlue }
    public static var platformSecondaryBackground: UIColor { .secondarySystemBackground }
    public static var platformBackground: UIColor { .systemBackground }
}
#endif
