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

/// The scoped editor surface passed to a plugin.
///
/// Layer names are namespaced by plugin and every layer registered here is removed
/// even when installation fails or the plugin forgets to clean it up itself.
public final class MarkdownPluginContext {
    public private(set) weak var editor: MarkdownTextView?
    public let name: String
    private var layers: Set<String> = []
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

    private func layerName(_ local: String) -> String? {
        guard !local.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return "plugin:\(name):\(local)"
    }

    fileprivate func removeAllLayers() {
        defer { active = false }
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
        guard let index = pluginInstallations.firstIndex(where: { $0.context.name == name }) else {
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
