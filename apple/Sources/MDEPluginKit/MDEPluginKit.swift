import Foundation
import MDECore

public enum MarkdownPluginAPI {
    public static let version = 1
}

public struct MarkdownPluginCapability: OptionSet, Sendable, Hashable {
    public let rawValue: UInt32
    public init(rawValue: UInt32) { self.rawValue = rawValue }
    public static let document = Self(rawValue: 1 << 0)
    public static let selection = Self(rawValue: 1 << 1)
    public static let semantics = Self(rawValue: 1 << 2)
    public static let state = Self(rawValue: 1 << 3)
    public static let commands = Self(rawValue: 1 << 4)
    public static let presentations = Self(rawValue: 1 << 5)
    public static let decorations = Self(rawValue: 1 << 6)
    public static let analysis = Self(rawValue: 1 << 7)
    public static let inputRules = Self(rawValue: 1 << 8)
    public static let transfers = Self(rawValue: 1 << 9)
    public static let resources = Self(rawValue: 1 << 10)
    public static let renderers = Self(rawValue: 1 << 11)
    public static let all: Self = [
        .document, .selection, .semantics, .state, .commands, .presentations,
        .decorations, .analysis, .inputRules, .transfers, .resources, .renderers,
    ]
}

public struct MarkdownPluginRequirement: Sendable, Equatable {
    public var apiVersion: Int
    public var capabilities: MarkdownPluginCapability
    public init(apiVersion: Int = MarkdownPluginAPI.version,
                capabilities: MarkdownPluginCapability = []) {
        self.apiVersion = apiVersion
        self.capabilities = capabilities
    }
}

public enum MarkdownPluginKitError: Error, Equatable {
    case unsupportedAPIVersion(requested: Int, host: Int)
    case missingCapabilities(MarkdownPluginCapability)
    case invalidTransaction
    case overlappingEdits
}

public struct MarkdownPluginTextEdit: Sendable, Equatable {
    public var range: NSRange
    public var text: String
    public init(range: NSRange, text: String) { self.range = range; self.text = text }
}

public struct MarkdownPluginTransaction: Sendable, Equatable {
    public var edits: [MarkdownPluginTextEdit]
    public var selection: NSRange?
    public var label: String?
    public var origin: String?
    public init(edits: [MarkdownPluginTextEdit], selection: NSRange? = nil,
                label: String? = nil, origin: String? = nil) {
        self.edits = edits; self.selection = selection; self.label = label; self.origin = origin
    }
}

public struct MarkdownPluginTransactionResult: Sendable, Equatable {
    public let beforeLength: Int
    public let afterLength: Int
    public let changedRange: NSRange?
    public init(beforeLength: Int, afterLength: Int, changedRange: NSRange?) {
        self.beforeLength = beforeLength; self.afterLength = afterLength
        self.changedRange = changedRange
    }
}

public struct MarkdownSemanticNode: Sendable, Equatable {
    public let range: NSRange
    public let role: String
    public let payload: String?
    public let source: String
    public let layer: UInt8
    public init(range: NSRange, role: String, payload: String?, source: String, layer: UInt8) {
        self.range = range; self.role = role; self.payload = payload
        self.source = source; self.layer = layer
    }
}

public struct MarkdownSemanticQuery: Sendable, Equatable {
    public var roles: Set<String>?
    public var range: NSRange?
    public var position: Int?
    public var intersects: Bool
    public init(roles: Set<String>? = nil, range: NSRange? = nil,
                position: Int? = nil, intersects: Bool = true) {
        self.roles = roles; self.range = range; self.position = position
        self.intersects = intersects
    }
}

public protocol MarkdownPluginStateStore: AnyObject {
    func value(plugin: String, key: String) -> Any?
    func setValue(_ value: Any?, plugin: String, key: String)
}

public enum MarkdownTransferKind: Sendable { case paste, drop, host }
public struct MarkdownTransfer: @unchecked Sendable {
    public let kind: MarkdownTransferKind
    public let value: Any
    public let position: Int?
    public init(kind: MarkdownTransferKind, value: Any, position: Int? = nil) {
        self.kind = kind; self.value = value; self.position = position
    }
}
