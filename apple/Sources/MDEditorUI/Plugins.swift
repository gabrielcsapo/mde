import Foundation
import MDECore
import MDEPluginKit

/// A runtime editor extension with an automatically managed lifecycle.
public protocol MarkdownPlugin: AnyObject {
    /// Stable, package-qualified identity, for example `com.acme.comments`.
    var name: String { get }
    /// Optional TOML syntax contributed before the editor's engine is created.
    var manifest: String? { get }
    var requirement: MarkdownPluginRequirement { get }
    func install(in context: MarkdownPluginContext) throws
    func uninstall()
    func markdownDidChange()
    func selectionDidChange()
}

public extension MarkdownPlugin {
    var manifest: String? { nil }
    var requirement: MarkdownPluginRequirement { MarkdownPluginRequirement() }
    func uninstall() {}
    func markdownDidChange() {}
    func selectionDidChange() {}
}

public enum MarkdownPluginError: Error, Equatable {
    case emptyName
    case duplicateName(String)
    case invalidManifest
    case unsupportedAPIVersion(Int)
    case missingCapabilities(MarkdownPluginCapability)
}

public struct MarkdownPluginCommandModifiers: OptionSet, Sendable {
    public let rawValue: UInt
    public init(rawValue: UInt) { self.rawValue = rawValue }
    public static let primary = Self(rawValue: 1 << 0)
    public static let shift = Self(rawValue: 1 << 1)
    public static let option = Self(rawValue: 1 << 2)
}

public struct MarkdownPluginCommand {
    public var title: String
    public var key: String?
    public var modifiers: MarkdownPluginCommandModifiers
    public var category: String?
    public var keywords: [String]
    public var isDiscoverable: Bool
    public var isEnabled: () -> Bool
    public var isChecked: () -> Bool
    public var handler: () -> Void

    public init(
        title: String,
        key: String? = nil,
        modifiers: MarkdownPluginCommandModifiers = [],
        category: String? = nil,
        keywords: [String] = [],
        isDiscoverable: Bool = true,
        isEnabled: @escaping () -> Bool = { true },
        isChecked: @escaping () -> Bool = { false },
        handler: @escaping () -> Void
    ) {
        self.title = title
        self.key = key
        self.modifiers = modifiers
        self.category = category
        self.keywords = keywords
        self.isDiscoverable = isDiscoverable
        self.isEnabled = isEnabled
        self.isChecked = isChecked
        self.handler = handler
    }
}

public struct MarkdownPluginCommandDescriptor: Equatable, Sendable {
    public let id: String
    public let plugin: String
    public let name: String
    public let title: String
    public let key: String?
    public let modifiers: MarkdownPluginCommandModifiers
    public let category: String?
    public let keywords: [String]
    public let isEnabled: Bool
    public let isChecked: Bool
}

public final class MarkdownPluginCommandHandle {
    public let id: String
    private let updateImpl: (MarkdownPluginCommand) -> Void
    private let unregisterImpl: () -> Void

    fileprivate init(
        id: String,
        update: @escaping (MarkdownPluginCommand) -> Void,
        unregister: @escaping () -> Void
    ) {
        self.id = id
        updateImpl = update
        unregisterImpl = unregister
    }

    public func update(_ command: MarkdownPluginCommand) { updateImpl(command) }
    public func unregister() { unregisterImpl() }
}

public enum MarkdownPluginPresentationAnchor: Sendable {
    case selection
    case editor
    case viewport
}

public enum MarkdownPluginPresentationPlacement: Sendable {
    case automatic
    case above
    case below
}

public enum MarkdownPluginPresentationDismissReason: Sendable, Equatable {
    case programmatic
    case escape
    case outsideInteraction
    case replaced
    case pluginRemoved
}

public struct MarkdownPluginPresentationOptions {
    public var view: PlatformView
    public var anchor: MarkdownPluginPresentationAnchor
    public var placement: MarkdownPluginPresentationPlacement
    public var offset: CGFloat
    public var modal: Bool
    public var dismissOnEscape: Bool
    public var dismissOnOutsideInteraction: Bool?
    public var restoreFocus: Bool
    public weak var initialFocus: PlatformView?
    public var onDismiss: ((MarkdownPluginPresentationDismissReason) -> Void)?

    public init(
        view: PlatformView,
        anchor: MarkdownPluginPresentationAnchor = .selection,
        placement: MarkdownPluginPresentationPlacement = .automatic,
        offset: CGFloat = 8,
        modal: Bool = false,
        dismissOnEscape: Bool = true,
        dismissOnOutsideInteraction: Bool? = nil,
        restoreFocus: Bool = true,
        initialFocus: PlatformView? = nil,
        onDismiss: ((MarkdownPluginPresentationDismissReason) -> Void)? = nil
    ) {
        self.view = view
        self.anchor = anchor
        self.placement = placement
        self.offset = max(0, offset)
        self.modal = modal
        self.dismissOnEscape = dismissOnEscape
        self.dismissOnOutsideInteraction = dismissOnOutsideInteraction
        self.restoreFocus = restoreFocus
        self.initialFocus = initialFocus
        self.onDismiss = onDismiss
    }
}

public final class MarkdownPluginPresentationHandle {
    public let id: String
    private let updateImpl: (MarkdownPluginPresentationOptions) -> Void
    private let repositionImpl: () -> Void
    private let dismissImpl: (MarkdownPluginPresentationDismissReason) -> Void

    fileprivate init(
        id: String,
        update: @escaping (MarkdownPluginPresentationOptions) -> Void,
        reposition: @escaping () -> Void,
        dismiss: @escaping (MarkdownPluginPresentationDismissReason) -> Void
    ) {
        self.id = id
        updateImpl = update
        repositionImpl = reposition
        dismissImpl = dismiss
    }

    public func update(_ options: MarkdownPluginPresentationOptions) { updateImpl(options) }
    public func reposition() { repositionImpl() }
    public func dismiss(_ reason: MarkdownPluginPresentationDismissReason = .programmatic) {
        dismissImpl(reason)
    }
}

struct MarkdownPluginCommandRegistration {
    let id: String
    let plugin: String
    let name: String
    let generation: UUID
    var command: MarkdownPluginCommand
}

struct MarkdownPluginPresentation {
    let generation: UUID
    var options: MarkdownPluginPresentationOptions
}

public struct MarkdownPluginInputRequest {
    public let inputType: String
    public let text: String?
    public let selection: NSRange
    public let markdown: String
}

public struct MarkdownPluginInputRule {
    public var priority: Int
    public var match: (MarkdownPluginInputRequest) -> Bool
    public var apply: (MarkdownPluginInputRequest) -> MarkdownPluginTransaction?
    public init(priority: Int = 0,
                match: @escaping (MarkdownPluginInputRequest) -> Bool,
                apply: @escaping (MarkdownPluginInputRequest) -> MarkdownPluginTransaction?) {
        self.priority = priority; self.match = match; self.apply = apply
    }
}

public struct MarkdownPluginTransferHandler {
    public var priority: Int
    public var accepts: (MarkdownTransfer) -> Bool
    public var handle: (MarkdownTransfer) -> Bool
    public init(priority: Int = 0, accepts: @escaping (MarkdownTransfer) -> Bool,
                handle: @escaping (MarkdownTransfer) -> Bool) {
        self.priority = priority; self.accepts = accepts; self.handle = handle
    }
}

public struct MarkdownPluginResourceContribution {
    public let resolver: any ResourceResolver
    public let priority: Int
    public let accepts: (ResourceRequest) -> Bool
    public init(resolver: any ResourceResolver, priority: Int = 0,
                accepts: @escaping (ResourceRequest) -> Bool = { _ in true }) {
        self.resolver = resolver; self.priority = priority; self.accepts = accepts
    }
}

/// One plugin-owned renderer in the editor's ordinary widget pipeline.
public struct MarkdownPluginRendererContribution {
    public var matches: (String, String, String?) -> Bool
    public var makeWidget: (String, String, String?) -> PlatformView?
    public var updateWidget: (PlatformView, String, String, String?) -> Void
    public var removeWidget: (PlatformView) -> Void
    public var size: (String, String, CGFloat) -> CGSize?
    public var wantsTouches: (String, String, String?) -> Bool

    public init(
        matches: @escaping (String, String, String?) -> Bool,
        makeWidget: @escaping (String, String, String?) -> PlatformView?,
        updateWidget: @escaping (PlatformView, String, String, String?) -> Void = { _, _, _, _ in },
        removeWidget: @escaping (PlatformView) -> Void = { _ in },
        size: @escaping (String, String, CGFloat) -> CGSize? = { _, _, _ in nil },
        wantsTouches: @escaping (String, String, String?) -> Bool = { _, _, _ in false }
    ) {
        self.matches = matches
        self.makeWidget = makeWidget
        self.updateWidget = updateWidget
        self.removeWidget = removeWidget
        self.size = size
        self.wantsTouches = wantsTouches
    }
}

struct MarkdownPluginRendererRegistration {
    let plugin: String
    let order: Int
    let contribution: MarkdownPluginRendererContribution
}

final class CompositePluginWidgetProvider: WidgetProvider {
    let registrations: [MarkdownPluginRendererRegistration]
    let fallback: (any WidgetProvider)?
    private var owners: [ObjectIdentifier: MarkdownPluginRendererContribution] = [:]

    init(registrations: [MarkdownPluginRendererRegistration], fallback: (any WidgetProvider)?) {
        self.registrations = registrations.sorted { $0.order < $1.order }
        self.fallback = fallback
    }

    private func contribution(
        roleName: String,
        source: String,
        payload: String?
    ) -> MarkdownPluginRendererContribution? {
        registrations.first {
            $0.contribution.matches(roleName, source, payload)
        }?.contribution
    }

    func makeWidget(roleName: String, source: String, payload: String?) -> PlatformView? {
        if let contribution = contribution(roleName: roleName, source: source, payload: payload),
           let view = contribution.makeWidget(roleName, source, payload) {
            owners[ObjectIdentifier(view)] = contribution
            return view
        }
        return fallback?.makeWidget(roleName: roleName, source: source, payload: payload)
    }

    func updateWidget(_ view: PlatformView, roleName: String, source: String, payload: String?) {
        if let owner = owners[ObjectIdentifier(view)] {
            owner.updateWidget(view, roleName, source, payload)
        } else {
            fallback?.updateWidget(view, roleName: roleName, source: source, payload: payload)
        }
    }

    func removeWidget(_ view: PlatformView) {
        if let owner = owners.removeValue(forKey: ObjectIdentifier(view)) {
            owner.removeWidget(view)
        } else {
            fallback?.removeWidget(view)
        }
    }

    func widgetSize(roleName: String, source: String, fittingWidth: CGFloat) -> CGSize? {
        if let contribution = contribution(roleName: roleName, source: source, payload: nil),
           let size = contribution.size(roleName, source, fittingWidth) {
            return size
        }
        return fallback?.widgetSize(roleName: roleName, source: source, fittingWidth: fittingWidth)
    }

    func widgetWantsTouches(roleName: String) -> Bool {
        fallback?.widgetWantsTouches(roleName: roleName) ?? false
    }

    func widgetWantsTouches(roleName: String, source: String, payload: String?) -> Bool {
        contribution(roleName: roleName, source: source, payload: payload)?
            .wantsTouches(roleName, source, payload)
            ?? fallback?.widgetWantsTouches(roleName: roleName, source: source, payload: payload)
            ?? false
    }
}

struct MarkdownPluginResourceRegistration {
    let order: Int
    let contribution: MarkdownPluginResourceContribution
}

private final class CompositePluginResourceResolver: ResourceResolver {
    let registrations: [MarkdownPluginResourceRegistration]
    let fallback: (any ResourceResolver)?
    init(registrations: [MarkdownPluginResourceRegistration], fallback: (any ResourceResolver)?) {
        self.registrations = registrations; self.fallback = fallback
    }
    private func resolver(_ request: ResourceRequest) -> (any ResourceResolver)? {
        registrations.sorted {
            $0.contribution.priority == $1.contribution.priority
                ? $0.order < $1.order : $0.contribution.priority > $1.contribution.priority
        }.first(where: { $0.contribution.accepts(request) })?.contribution.resolver ?? fallback
    }
    func resolve(_ request: ResourceRequest,
                 deliver: @escaping (ResourceState) -> Void) -> ResourceState {
        resolver(request)?.resolve(request, deliver: deliver) ?? .failed("no resolver")
    }
    func reservedSize(_ request: ResourceRequest) -> CGSize {
        resolver(request)?.reservedSize(request) ?? CGSize(width: 320, height: 180)
    }
}

public struct MarkdownPluginAnalysisDiagnostic: Sendable {
    public let plugin: String
    public let task: String
    public let duration: TimeInterval
    public let budget: TimeInterval
    public let overBudget: Bool
    public let cancelled: Bool
}

public extension Notification.Name {
    static let markdownPluginAnalysisDiagnostic = Notification.Name(
        "dev.mde.plugin-analysis-diagnostic"
    )
    static let markdownPluginCommandsDidChange = Notification.Name(
        "dev.mde.plugin-commands-did-change"
    )
    static let markdownPluginCommandConflict = Notification.Name(
        "dev.mde.plugin-command-conflict"
    )
}

public enum MarkdownPluginManifests {
    /// Combine package-owned TOML fragments without changing any source fragment.
    public static func compose(
        base: String? = nil,
        plugins: [any MarkdownPlugin]
    ) -> String? {
        let fragments = [base] + plugins.map(\.manifest)
        let present = fragments.compactMap { fragment -> String? in
            guard let fragment,
                  !fragment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            return fragment
        }
        return present.isEmpty ? nil : present.joined(separator: "\n\n")
    }
}

/// Cooperative cancellation passed to background plugin analysis.
public final class MarkdownPluginAnalysisCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    public var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    fileprivate func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }
}

private final class MarkdownPluginAnalysisRun {
    let id = UUID()
    let cancellation = MarkdownPluginAnalysisCancellation()
    var workItem: DispatchWorkItem?
    var budget: TimeInterval = 0.016
}

public struct MarkdownPluginCompatibilityReport: Equatable {
    public let name: String
    public let installed: Bool
    public let removed: Bool
    public let sourcePreserved: Bool
    public let contributedLayerDecorations: Int
    public let cleanupRemovedLayers: Bool
}

public final class MarkdownPluginDocument {
    private weak var editor: MarkdownTextView?
    fileprivate let plugin: String
    fileprivate init(editor: MarkdownTextView, plugin: String) {
        self.editor = editor; self.plugin = plugin
    }
    public var markdown: String { editor?.markdown ?? "" }
    public var length: Int { (markdown as NSString).length }
    public func substring(in range: NSRange) -> String? {
        let source = markdown as NSString
        guard range.location != NSNotFound, range.location <= source.length,
              range.length <= source.length - range.location else { return nil }
        return source.substring(with: range)
    }
    @discardableResult
    public func transact(_ transaction: MarkdownPluginTransaction) throws
        -> MarkdownPluginTransactionResult {
        guard let editor else { throw MarkdownPluginKitError.invalidTransaction }
        let before = editor.markdown as NSString
        let edits = transaction.edits.sorted {
            $0.range.location == $1.range.location
                ? $0.range.length < $1.range.length : $0.range.location < $1.range.location
        }
        var previousEnd = 0
        for (index, edit) in edits.enumerated() {
            let range = edit.range
            guard range.location != NSNotFound, range.location <= before.length,
                  range.length <= before.length - range.location else {
                throw MarkdownPluginKitError.invalidTransaction
            }
            if index > 0, range.location < previousEnd {
                throw MarkdownPluginKitError.overlappingEdits
            }
            previousEnd = NSMaxRange(range)
        }
        let next = NSMutableString(string: before)
        for edit in edits.reversed() { next.replaceCharacters(in: edit.range, with: edit.text) }
        if let selection = transaction.selection,
           selection.location == NSNotFound || selection.location > next.length
            || selection.length > next.length - selection.location {
            throw MarkdownPluginKitError.invalidTransaction
        }
        var start = 0
        while start < min(before.length, next.length),
              before.character(at: start) == next.character(at: start) { start += 1 }
        var beforeEnd = before.length
        var afterEnd = next.length
        while beforeEnd > start, afterEnd > start,
              before.character(at: beforeEnd - 1) == next.character(at: afterEnd - 1) {
            beforeEnd -= 1; afterEnd -= 1
        }
        let changed: NSRange? = beforeEnd == start && afterEnd == start
            ? nil : NSRange(location: start, length: afterEnd - start)
        if changed != nil {
            let replacement = next.substring(with: NSRange(location: start, length: afterEnd - start))
            guard editor.replaceMarkdown(
                in: NSRange(location: start, length: beforeEnd - start),
                with: replacement, selection: transaction.selection
            ) else { throw MarkdownPluginKitError.invalidTransaction }
        } else if let selection = transaction.selection {
            editor.selectedRange = selection
        }
        return MarkdownPluginTransactionResult(
            beforeLength: before.length, afterLength: next.length, changedRange: changed
        )
    }
}

public final class MarkdownPluginSelection {
    private weak var editor: MarkdownTextView?
    fileprivate init(editor: MarkdownTextView) { self.editor = editor }
    public var range: NSRange? {
        get { editor?.selectedRange }
        set { if let newValue { editor?.selectedRange = newValue } }
    }
    public var isActive: Bool {
        guard let editor else { return false }
        #if os(macOS)
        return editor.window?.firstResponder === editor
        #else
        return editor.isFirstResponder
        #endif
    }
}

public final class MarkdownPluginSemantics {
    private weak var editor: MarkdownTextView?
    fileprivate init(editor: MarkdownTextView) { self.editor = editor }
    public func query(_ query: MarkdownSemanticQuery = MarkdownSemanticQuery())
        -> [MarkdownSemanticNode] {
        guard let editor else { return [] }
        let source = editor.markdown as NSString
        return editor.decorations.compactMap { decoration in
            guard let role = editor.engine.roleName(decoration.role),
                  query.roles?.contains(role) ?? true else { return nil }
            if let position = query.position,
               position < decoration.range.location || position > NSMaxRange(decoration.range) {
                return nil
            }
            if let range = query.range {
                let matches = query.intersects
                    ? NSIntersectionRange(range, decoration.range).length > 0
                    : decoration.range.location <= range.location
                        && NSMaxRange(decoration.range) >= NSMaxRange(range)
                if !matches { return nil }
            }
            guard NSMaxRange(decoration.range) <= source.length else { return nil }
            let payload = editor.engine.payload(for: decoration.key)
            let nodeSource = source.substring(with: decoration.range)
            return MarkdownSemanticNode(
                range: decoration.range, role: role,
                payload: payload, source: nodeSource, layer: decoration.layer
            )
        }.sorted {
            $0.range.length == $1.range.length
                ? $0.range.location < $1.range.location : $0.range.length < $1.range.length
        }
    }
    public func nodes(at position: Int, roles: Set<String>? = nil) -> [MarkdownSemanticNode] {
        query(MarkdownSemanticQuery(roles: roles, position: position))
    }
}

public final class MarkdownPluginState {
    private let plugin: String
    private weak var store: (any MarkdownPluginStateStore)?
    private var values: [String: Any] = [:]
    fileprivate init(plugin: String, store: (any MarkdownPluginStateStore)?) {
        self.plugin = plugin; self.store = store
    }
    public func value<Value>(for key: String, default fallback: Value) -> Value {
        (values[key] ?? store?.value(plugin: plugin, key: key)) as? Value ?? fallback
    }
    public func setValue(_ value: Any?, for key: String) {
        values[key] = value; store?.setValue(value, plugin: plugin, key: key)
    }
}

/// Framework-neutral lifecycle check for plugin package test suites.
public enum MarkdownPluginCompatibility {
    public static func check(
        _ plugin: any MarkdownPlugin,
        in editor: MarkdownTextView,
        markdown: String = "# Plugin compatibility\n\nTest **content**.\n"
    ) throws -> MarkdownPluginCompatibilityReport {
        editor.setMarkdown(markdown)
        let before = Set(editor.decorations.filter { $0.layer > 0 }.map(\.key))
        try editor.installPlugin(plugin)
        let name = plugin.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let installed = editor.installedPluginNames.contains(name)
        let during = Set(editor.decorations.filter { $0.layer > 0 }.map(\.key))
        let contributed = during.subtracting(before)
        let sourcePreserved = editor.markdown == markdown
        let removed = editor.removePlugin(named: name)
        let after = Set(editor.decorations.filter { $0.layer > 0 }.map(\.key))
        return MarkdownPluginCompatibilityReport(
            name: name,
            installed: installed,
            removed: removed,
            sourcePreserved: sourcePreserved,
            contributedLayerDecorations: contributed.count,
            cleanupRemovedLayers: contributed.isDisjoint(with: after)
        )
    }
}

/// The scoped editor surface passed to a plugin.
///
/// Layer names are namespaced by plugin and every layer registered here is removed
/// even when installation fails or the plugin forgets to clean it up itself.
public final class MarkdownPluginContext {
    private static let analysisQueue = DispatchQueue(
        label: "dev.mde.plugin-analysis",
        qos: .userInitiated,
        attributes: .concurrent
    )

    private weak var editorStorage: MarkdownTextView?
    @available(*, deprecated, message: "Use document, selection, semantics, and scoped capabilities")
    public var editor: MarkdownTextView? { editorStorage }
    public let name: String
    public let apiVersion = MarkdownPluginAPI.version
    public let capabilities = MarkdownPluginCapability.all
    public let document: MarkdownPluginDocument
    public let selection: MarkdownPluginSelection
    public let semantics: MarkdownPluginSemantics
    public let state: MarkdownPluginState
    private var layers: Set<String> = []
    private var commands: Set<String> = []
    private var presentations: Set<String> = []
    private var analyses: [String: MarkdownPluginAnalysisRun] = [:]
    private var inputRules: [(order: Int, rule: MarkdownPluginInputRule)] = []
    private var transfers: [(order: Int, handler: MarkdownPluginTransferHandler)] = []
    private var registrationOrder = 0
    private var resources: Set<String> = []
    private var renderers: Set<String> = []
    private var active = true

    fileprivate init(editor: MarkdownTextView, name: String) {
        editorStorage = editor
        self.name = name
        document = MarkdownPluginDocument(editor: editor, plugin: name)
        selection = MarkdownPluginSelection(editor: editor)
        semantics = MarkdownPluginSemantics(editor: editor)
        state = MarkdownPluginState(plugin: name, store: editor.pluginStateStore)
    }

    public func internRole(_ name: String) -> UInt32 {
        active ? (editorStorage?.internRole(name) ?? UInt32.max) : UInt32.max
    }

    public func setLayer(_ name: String, _ spans: [LayerSpan]) {
        guard active, let editor = editorStorage, let qualified = layerName(name) else { return }
        layers.insert(qualified)
        editor.setLayer(qualified, spans)
    }

    public func clearLayer(_ name: String) {
        guard active, let editor = editorStorage, let qualified = layerName(name) else { return }
        layers.remove(qualified)
        editor.clearLayer(qualified)
    }

    /// Register an editor-scoped hardware-keyboard command. It is removed with the plugin.
    @discardableResult
    public func registerCommand(
        _ name: String,
        command: MarkdownPluginCommand
    ) -> MarkdownPluginCommandHandle? {
        guard active, let editor = editorStorage, let qualified = qualified("command", name) else { return nil }
        let canonical = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let generation = UUID()
        commands.insert(qualified)
        editor.setPluginCommand(qualified, MarkdownPluginCommandRegistration(
            id: qualified,
            plugin: self.name,
            name: canonical,
            generation: generation,
            command: command
        ))
        return MarkdownPluginCommandHandle(
            id: qualified,
            update: { [weak self, weak editor] updated in
                guard let self, self.active else { return }
                editor?.updatePluginCommand(qualified, generation: generation, command: updated)
            },
            unregister: { [weak self, weak editor] in
                guard let self, self.active,
                      editor?.removePluginCommand(qualified, generation: generation) == true
                else { return }
                self.commands.remove(qualified)
            }
        )
    }

    /// Convenience overload for a keyboard-backed command.
    @discardableResult
    public func registerCommand(
        _ name: String,
        title: String,
        key: String,
        modifiers: MarkdownPluginCommandModifiers = [.primary],
        handler: @escaping () -> Void
    ) -> MarkdownPluginCommandHandle? {
        guard !key.isEmpty else { return nil }
        return registerCommand(name, command: MarkdownPluginCommand(
            title: title,
            key: key,
            modifiers: modifiers,
            handler: handler
        ))
    }

    /// Place a plugin-owned view above the editor without inserting it into markdown storage.
    @discardableResult
    public func showPresentation(
        _ name: String,
        options: MarkdownPluginPresentationOptions
    ) -> MarkdownPluginPresentationHandle? {
        guard active, let editor = editorStorage, let qualified = qualified("presentation", name) else {
            return nil
        }
        let generation = UUID()
        presentations.insert(qualified)
        editor.setPluginPresentation(
            qualified, MarkdownPluginPresentation(generation: generation, options: options)
        )
        return MarkdownPluginPresentationHandle(
            id: qualified,
            update: { [weak self, weak editor] updated in
                guard let self, self.active else { return }
                editor?.updatePluginPresentation(
                    qualified, generation: generation, options: updated
                )
            },
            reposition: { [weak self, weak editor] in
                guard let self, self.active else { return }
                editor?.repositionPluginPresentation(qualified, generation: generation)
            },
            dismiss: { [weak self, weak editor] reason in
                guard let self, self.active,
                      editor?.removePluginPresentation(
                        qualified, generation: generation, reason: reason
                      ) == true
                else { return }
                self.presentations.remove(qualified)
            }
        )
    }

    @discardableResult
    public func showPresentation(
        _ name: String,
        view: PlatformView,
        anchor: MarkdownPluginPresentationAnchor = .selection,
        placement: MarkdownPluginPresentationPlacement = .automatic,
        offset: CGFloat = 8,
        modal: Bool = false
    ) -> MarkdownPluginPresentationHandle? {
        showPresentation(name, options: MarkdownPluginPresentationOptions(
            view: view,
            anchor: anchor,
            placement: placement,
            offset: offset,
            modal: modal
        ))
    }

    public func dismissPresentation(
        _ name: String,
        reason: MarkdownPluginPresentationDismissReason = .programmatic
    ) {
        guard active, let editor = editorStorage, let qualified = qualified("presentation", name) else { return }
        presentations.remove(qualified)
        editor.removePluginPresentation(qualified, reason: reason)
    }

    public var registeredCommands: [MarkdownPluginCommandDescriptor] {
        editorStorage?.registeredPluginCommands ?? []
    }

    @discardableResult
    public func executeCommand(_ id: String) -> Bool {
        editorStorage?.executePluginCommand(id: id) ?? false
    }

    public var hasMarkedText: Bool {
        guard let editor = editorStorage else { return false }
        #if os(macOS)
        return editor.hasMarkedText()
        #else
        return editor.markedTextRange != nil
        #endif
    }

    @discardableResult
    public func focusEditor() -> Bool { editorStorage?.becomeFirstResponder() ?? false }

    public func registerInputRule(_ rule: MarkdownPluginInputRule) {
        guard active else { return }
        registrationOrder += 1
        inputRules.append((registrationOrder, rule))
    }

    public func registerTransferHandler(_ handler: MarkdownPluginTransferHandler) {
        guard active else { return }
        registrationOrder += 1
        transfers.append((registrationOrder, handler))
    }

    public func registerResourceResolver(
        _ name: String,
        contribution: MarkdownPluginResourceContribution
    ) {
        guard active, let editor = editorStorage, let qualified = qualified("resource", name) else { return }
        registrationOrder += 1
        resources.insert(qualified)
        editor.pluginResourceContributions[qualified] = MarkdownPluginResourceRegistration(
            order: registrationOrder, contribution: contribution
        )
        editor.refreshPluginResourceResolver()
    }

    public func registerRenderer(
        _ name: String,
        contribution: MarkdownPluginRendererContribution
    ) {
        guard active, let editor = editorStorage, let qualified = qualified("renderer", name) else {
            return
        }
        registrationOrder += 1
        renderers.insert(qualified)
        editor.pluginRendererContributions[qualified] = MarkdownPluginRendererRegistration(
            plugin: self.name,
            order: registrationOrder,
            contribution: contribution
        )
        editor.refreshPluginWidgetProvider()
    }

    fileprivate func applyInputRule(_ request: MarkdownPluginInputRequest) -> Bool {
        let ordered = inputRules.sorted {
            $0.rule.priority == $1.rule.priority
                ? $0.order < $1.order : $0.rule.priority > $1.rule.priority
        }
        for entry in ordered where entry.rule.match(request) {
            guard let transaction = entry.rule.apply(request) else { continue }
            return (try? document.transact(transaction)) != nil
        }
        return false
    }

    fileprivate func routeTransfer(_ transfer: MarkdownTransfer) -> Bool {
        let ordered = transfers.sorted {
            $0.handler.priority == $1.handler.priority
                ? $0.order < $1.order : $0.handler.priority > $1.handler.priority
        }
        for entry in ordered where entry.handler.accepts(transfer) {
            if entry.handler.handle(transfer) { return true }
        }
        return false
    }

    /// Schedule latest-wins work against an immutable markdown snapshot.
    ///
    /// Scheduling the same name again cooperatively cancels the old operation. Its
    /// result is never applied, even if the operation does not observe cancellation
    /// before returning. The apply closure always runs on the main queue.
    @discardableResult
    public func scheduleAnalysis<Result>(
        _ name: String,
        delay: TimeInterval = 0,
        budget: TimeInterval = 0.016,
        analyze: @escaping (String, MarkdownPluginAnalysisCancellation) -> Result,
        apply: @escaping (Result, MarkdownPluginContext) -> Void
    ) -> Bool {
        let canonical = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard active, !canonical.isEmpty, let markdown = editorStorage?.markdown else { return false }
        cancelAnalysis(canonical)

        let run = MarkdownPluginAnalysisRun()
        run.budget = max(0, budget)
        let item = DispatchWorkItem { [weak self, weak run] in
            guard let self, let run, !run.cancellation.isCancelled else { return }
            let started = DispatchTime.now().uptimeNanoseconds
            let result = analyze(markdown, run.cancellation)
            let duration = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
            guard !run.cancellation.isCancelled else { return }
            DispatchQueue.main.async { [weak self, weak run] in
                guard let self, let run,
                      self.active,
                      self.analyses[canonical]?.id == run.id,
                      !run.cancellation.isCancelled
                else { return }
                self.analyses.removeValue(forKey: canonical)
                self.postDiagnostic(
                    task: canonical, duration: duration, budget: run.budget, cancelled: false
                )
                apply(result, self)
            }
        }
        run.workItem = item
        analyses[canonical] = run
        Self.analysisQueue.asyncAfter(
            deadline: .now() + max(0, delay),
            execute: item
        )
        return true
    }

    public func cancelAnalysis(_ name: String) {
        let canonical = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let run = analyses.removeValue(forKey: canonical) else { return }
        run.cancellation.cancel()
        run.workItem?.cancel()
        postDiagnostic(task: canonical, duration: 0, budget: run.budget, cancelled: true)
    }

    private func postDiagnostic(
        task: String,
        duration: TimeInterval,
        budget: TimeInterval,
        cancelled: Bool
    ) {
        let diagnostic = MarkdownPluginAnalysisDiagnostic(
            plugin: name,
            task: task,
            duration: duration,
            budget: budget,
            overBudget: !cancelled && duration > budget,
            cancelled: cancelled
        )
        DispatchQueue.main.async { [weak editor = editorStorage] in
            guard let editor else { return }
            NotificationCenter.default.post(
                name: .markdownPluginAnalysisDiagnostic,
                object: editor,
                userInfo: ["diagnostic": diagnostic]
            )
        }
    }

    private func layerName(_ local: String) -> String? {
        qualified(nil, local)
    }

    private func qualified(_ kind: String?, _ local: String) -> String? {
        let canonical = local.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !canonical.isEmpty else { return nil }
        return ["plugin", name, kind, canonical].compactMap { $0 }.joined(separator: ":")
    }

    fileprivate func removeAllOwnedState() {
        defer { active = false }
        for name in Array(analyses.keys) { cancelAnalysis(name) }
        guard let editor = editorStorage else {
            layers.removeAll()
            commands.removeAll()
            presentations.removeAll()
            inputRules.removeAll()
            transfers.removeAll()
            resources.removeAll()
            renderers.removeAll()
            return
        }
        for layer in layers { editor.clearLayer(layer) }
        for command in commands { editor.removePluginCommand(command) }
        for presentation in presentations {
            editor.removePluginPresentation(presentation, reason: .pluginRemoved)
        }
        layers.removeAll()
        commands.removeAll()
        presentations.removeAll()
        inputRules.removeAll()
        transfers.removeAll()
        for resource in resources { editor.pluginResourceContributions.removeValue(forKey: resource) }
        resources.removeAll()
        editor.refreshPluginResourceResolver()
        for renderer in renderers { editor.pluginRendererContributions.removeValue(forKey: renderer) }
        renderers.removeAll()
        editor.refreshPluginWidgetProvider()
    }
}

final class MarkdownPluginInstallation {
    let plugin: any MarkdownPlugin
    let context: MarkdownPluginContext

    init(plugin: any MarkdownPlugin, context: MarkdownPluginContext) {
        self.plugin = plugin
        self.context = context
    }
}

public extension MarkdownTextView {
    /// Construct the engine with every plugin's syntax, then install their lifecycles.
    convenience init(
        plugins: [any MarkdownPlugin],
        manifest: String? = nil,
        theme: Theme = Theme()
    ) throws {
        let combined = MarkdownPluginManifests.compose(base: manifest, plugins: plugins)
        guard let engine = MarkdownEngine(manifest: combined) else {
            throw MarkdownPluginError.invalidManifest
        }
        self.init(engine: engine, theme: theme)
        for plugin in plugins { try installPlugin(plugin) }
    }

    /// Install a plugin once for this editor. Installation order is callback and paint order.
    func installPlugin(_ plugin: any MarkdownPlugin) throws {
        let name = plugin.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw MarkdownPluginError.emptyName }
        guard !pluginInstallations.contains(where: { $0.context.name == name }) else {
            throw MarkdownPluginError.duplicateName(name)
        }
        guard plugin.requirement.apiVersion == MarkdownPluginAPI.version else {
            throw MarkdownPluginError.unsupportedAPIVersion(plugin.requirement.apiVersion)
        }
        let missing = plugin.requirement.capabilities.subtracting(.all)
        guard missing.isEmpty else { throw MarkdownPluginError.missingCapabilities(missing) }

        let context = MarkdownPluginContext(editor: self, name: name)
        let installation = MarkdownPluginInstallation(plugin: plugin, context: context)
        pluginInstallations.append(installation)
        do {
            try plugin.install(in: context)
        } catch {
            pluginInstallations.removeAll { $0 === installation }
            plugin.uninstall()
            context.removeAllOwnedState()
            throw error
        }
        plugin.markdownDidChange()
        plugin.selectionDidChange()
    }

    @discardableResult
    func removePlugin(named name: String) -> Bool {
        let canonical = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let index = pluginInstallations.firstIndex(where: {
            $0.context.name == canonical
        }) else {
            return false
        }
        let installation = pluginInstallations.remove(at: index)
        installation.plugin.uninstall()
        installation.context.removeAllOwnedState()
        return true
    }

    var installedPluginNames: [String] {
        pluginInstallations.map(\.context.name)
    }

    /// Route host paste/drop/share-sheet data without coupling plugins to a view class.
    @discardableResult
    func routePluginTransfer(_ transfer: MarkdownTransfer) -> Bool {
        for installation in pluginInstallations {
            if installation.context.routeTransfer(transfer) { return true }
        }
        return false
    }

    @discardableResult
    internal func applyPluginInputRules(inputType: String, text: String?) -> Bool {
        let request = MarkdownPluginInputRequest(
            inputType: inputType, text: text, selection: selectedRange, markdown: markdown
        )
        for installation in pluginInstallations {
            if installation.context.applyInputRule(request) { return true }
        }
        return false
    }

    internal func refreshPluginResourceResolver() {
        let resolver: (any ResourceResolver)? = pluginResourceContributions.isEmpty
            ? pluginResourceBaseResolver
            : CompositePluginResourceResolver(
                registrations: Array(pluginResourceContributions.values),
                fallback: pluginResourceBaseResolver
            )
        applyPluginResourceResolver(resolver)
    }

    internal func pluginsDidChangeMarkdown() {
        for installation in pluginInstallations {
            installation.plugin.markdownDidChange()
        }
    }

    internal func pluginsDidChangeSelection() {
        for installation in pluginInstallations {
            installation.plugin.selectionDidChange()
        }
    }

    internal func uninstallAllPlugins() {
        while let installation = pluginInstallations.popLast() {
            installation.plugin.uninstall()
            installation.context.removeAllOwnedState()
        }
    }
}
