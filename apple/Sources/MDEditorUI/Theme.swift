import Foundation
import MDECore

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Maps decoration roles to text attributes. Roles are open strings in the core, so a
/// theme resolves built-ins by id (the fast path) and extension roles by name.
public struct Theme {
    public var bodyFont: PlatformFont
    public var monoFont: PlatformFont
    public var textColor: PlatformColor
    public var mutedColor: PlatformColor
    public var accentColor: PlatformColor
    public var codeBackground: PlatformColor
    public var lineSpacing: CGFloat

    /// Attributes for an extension role, keyed by the name the manifest declared.
    public var extensionRoles: [String: [NSAttributedString.Key: Any]]

    public init(
        bodyFont: PlatformFont = .platformBody,
        monoFont: PlatformFont = .platformMono(ofSize: 15),
        textColor: PlatformColor = .platformLabel,
        mutedColor: PlatformColor = .platformTertiaryLabel,
        accentColor: PlatformColor = .platformAccent,
        codeBackground: PlatformColor = .platformSecondaryBackground,
        lineSpacing: CGFloat = 4,
        extensionRoles: [String: [NSAttributedString.Key: Any]] = [:]
    ) {
        self.bodyFont = bodyFont
        self.monoFont = monoFont
        self.textColor = textColor
        self.mutedColor = mutedColor
        self.accentColor = accentColor
        self.codeBackground = codeBackground
        self.lineSpacing = lineSpacing
        self.extensionRoles = extensionRoles
    }

    public var baseAttributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        return [.font: bodyFont, .foregroundColor: textColor, .paragraphStyle: paragraph]
    }

    /// Heading sizes derive from the body font so Dynamic Type still applies.
    func headingFont(level: Int) -> PlatformFont {
        let scale: CGFloat = switch level {
        case 1: 1.75
        case 2: 1.45
        case 3: 1.25
        default: 1.1
        }
        return .platformSystem(ofSize: bodyFont.pointSize * scale, weight: .bold)
    }

    /// Attributes for one decoration. `headingLevel` comes from counting `#` in the
    /// source, since the core reports the role but not the level.
    func attributes(
        role: UInt32,
        roleName: @autoclosure () -> String?,
        headingLevel: Int
    ) -> [NSAttributedString.Key: Any] {
        switch role {
        case Role.heading:
            return [.font: headingFont(level: headingLevel), .foregroundColor: textColor]
        case Role.marker:
            return [.foregroundColor: mutedColor]
        case Role.emphasis:
            return [.font: bodyFont.withTraits(PlatformFont.platformItalicTrait)]
        case Role.strong:
            return [.font: bodyFont.withTraits(PlatformFont.platformBoldTrait)]
        case Role.strikethrough:
            return [
                .strikethroughStyle: NSUnderlineStyle.single.rawValue,
                .foregroundColor: mutedColor,
            ]
        case Role.codeInline, Role.codeBlock:
            return [.font: monoFont, .backgroundColor: codeBackground]
        case Role.linkText:
            return [
                .foregroundColor: accentColor,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
            ]
        case Role.link:
            return [.foregroundColor: mutedColor]
        case Role.quote, Role.listBullet:
            return [.foregroundColor: accentColor]
        case Role.taskCheckbox:
            return [.font: monoFont, .foregroundColor: accentColor]
        case Role.rule:
            return [.foregroundColor: mutedColor]
        default:
            guard let name = roleName(), let attrs = extensionRoles[name] else { return [:] }
            return attrs
        }
    }
}
