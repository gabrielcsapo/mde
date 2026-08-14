import Foundation
import MDECore

/// A runtime editor extension with an automatically managed lifecycle.
public protocol MarkdownPlugin: AnyObject {
    /// Stable, package-qualified identity, for example `com.acme.comments`.
    var name: String { get }
    /// Optional TOML syntax contributed before the editor's engine is created.
    var manifest: String? { get }
    func install(in context: MarkdownPluginContext) throws
    func uninstall()
    func markdownDidChange()
    func selectionDidChange()
}

public extension MarkdownPlugin {
    var manifest: String? { nil }
    func uninstall() {}
    func markdownDidChange() {}
    func selectionDidChange() {}
}

public enum MarkdownPluginError: Error, Equatable {
    case emptyName
    case duplicateName(String)
    case invalidManifest
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

    public private(set) weak var editor: MarkdownTextView?
    public let name: String
    private var layers: Set<String> = []
    private var commands: Set<String> = []
    private var presentations: Set<String> = []
    private var analyses: [String: MarkdownPluginAnalysisRun] = [:]
    private var active = true

    fileprivate init(editor: MarkdownTextView, name: String) {
        self.editor = editor
        self.name = name
    }

    public func internRole(_ name: String) -> UInt32 {
        active ? (editor?.internRole(name) ?? UInt32.max) : UInt32.max
    }

    public func setLayer(_ name: String, _ spans: [LayerSpan]) {
        guard active, let editor, let qualified = layerName(name) else { return }
        layers.insert(qualified)
        editor.setLayer(qualified, spans)
    }

    public func clearLayer(_ name: String) {
        guard active, let editor, let qualified = layerName(name) else { return }
        layers.remove(qualified)
        editor.clearLayer(qualified)
    }

    /// Register an editor-scoped hardware-keyboard command. It is removed with the plugin.
    @discardableResult
    public func registerCommand(
        _ name: String,
        command: MarkdownPluginCommand
    ) -> MarkdownPluginCommandHandle? {
        guard active, let editor, let qualified = qualified("command", name) else { return nil }
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
        guard active, let editor, let qualified = qualified("presentation", name) else {
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
        guard active, let editor, let qualified = qualified("presentation", name) else { return }
        presentations.remove(qualified)
        editor.removePluginPresentation(qualified, reason: reason)
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
        guard active, !canonical.isEmpty, let markdown = editor?.markdown else { return false }
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
        DispatchQueue.main.async { [weak editor] in
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
        guard let editor else {
            layers.removeAll()
            commands.removeAll()
            presentations.removeAll()
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
