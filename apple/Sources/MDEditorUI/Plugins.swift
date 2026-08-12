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
        guard !local.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return "plugin:\(name):\(local)"
    }

    fileprivate func removeAllLayers() {
        defer { active = false }
        for name in Array(analyses.keys) { cancelAnalysis(name) }
        guard let editor else {
            layers.removeAll()
            return
        }
        for layer in layers { editor.clearLayer(layer) }
        layers.removeAll()
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
            context.removeAllLayers()
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
        installation.context.removeAllLayers()
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
            installation.context.removeAllLayers()
        }
    }
}
