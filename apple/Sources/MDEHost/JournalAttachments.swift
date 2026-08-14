import Foundation
import MDEditorUI
import MDEPluginKit
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
#else
import UIKit
#endif

public enum MarkdownAttachmentKind: String, Sendable { case image, video, audio, file }

public struct MarkdownAttachmentImportResult: Sendable {
    public let reference: String
    public let kind: MarkdownAttachmentKind?
    public let alt: String?
    public let metadata: [String: String]

    public init(
        reference: String,
        kind: MarkdownAttachmentKind? = nil,
        alt: String? = nil,
        metadata: [String: String] = [:]
    ) {
        self.reference = reference; self.kind = kind; self.alt = alt; self.metadata = metadata
    }
}

public protocol MarkdownAttachmentImportCancellation: AnyObject { func cancel() }

public protocol MarkdownAttachmentImporting: AnyObject {
    /// Present the host's document/Photos/asset-library picker.
    func selectAttachments(completion: @escaping ([URL]) -> Void)
    /// Copy or upload an asset and return the durable reference stored in Markdown.
    func importAttachment(
        _ url: URL,
        progress: @escaping (Double) -> Void,
        completion: @escaping (Result<MarkdownAttachmentImportResult, Error>) -> Void
    ) -> (any MarkdownAttachmentImportCancellation)?
}

/// Native journal attachment workflow with host-owned picking/persistence and live progress.
public final class MarkdownAttachments: MarkdownPlugin {
    public let name = "mde.attachments"
    public weak var importer: (any MarkdownAttachmentImporting)?
    public var onImported: ((MarkdownAttachmentImportResult, URL) -> Void)?
    public var onError: ((Error, URL) -> Void)?
    private var context: MarkdownPluginContext?
    private var nextID = 0
    private var uploads: [Int: NativeAttachmentUpload] = [:]

    public init(importer: any MarkdownAttachmentImporting) { self.importer = importer }

    public func install(in context: MarkdownPluginContext) throws {
        self.context = context
        context.registerCommand("add", command: MarkdownPluginCommand(
            title: "Add photo, video, or audio", key: "o", modifiers: .primary,
            category: "Insert", keywords: ["attachment", "media", "file", "journal"]
        ) { [weak self] in self?.openPicker() })
        context.registerTransferHandler(MarkdownPluginTransferHandler(
            priority: 50,
            accepts: { $0.value is [URL] },
            handle: { [weak self] transfer in
                guard let urls = transfer.value as? [URL], !urls.isEmpty else { return false }
                self?.add(urls)
                return true
            }
        ))
    }

    public func uninstall() {
        for upload in uploads.values { upload.cancellation?.cancel() }
        uploads.removeAll(); context = nil
    }

    public func openPicker() {
        importer?.selectAttachments { [weak self] urls in
            DispatchQueue.main.async { self?.add(urls) }
        }
    }

    /// Hosts can route paste/drop/share-sheet URLs through the same tested import path.
    public func add(_ urls: [URL]) {
        guard let context, let importer else { return }
        for url in urls {
            nextID += 1
            let id = nextID
            let kind = attachmentKind(url)
            let alt = cleanAttachmentAlt(url)
            let placeholder = attachmentMarkdown(kind: kind, alt: alt, reference: url.absoluteString)
            let selection = context.selection.range ?? NSRange(location: context.document.length, length: 0)
            _ = try? context.document.transact(MarkdownPluginTransaction(
                edits: [MarkdownPluginTextEdit(range: selection, text: placeholder)],
                selection: NSRange(location: selection.location + placeholder.utf16.count, length: 0),
                label: "Insert attachment", origin: name
            ))
            let upload = NativeAttachmentUpload(id: id, url: url, placeholder: placeholder)
            uploads[id] = upload
            renderUploads()
            upload.cancellation = importer.importAttachment(
                url,
                progress: { [weak self] value in
                    let update = {
                        guard let upload = self?.uploads[id] else { return }
                        upload.progress = min(1, max(0, value)); self?.renderUploads()
                    }
                    if Thread.isMainThread { update() }
                    else { DispatchQueue.main.async(execute: update) }
                },
                completion: { [weak self] result in
                    let finish: () -> Void = { [weak self] in
                        self?.finish(id: id, kind: kind, result: result)
                    }
                    if Thread.isMainThread { finish() }
                    else { DispatchQueue.main.async(execute: finish) }
                }
            )
        }
    }

    private func finish(
        id: Int, kind: MarkdownAttachmentKind,
        result: Result<MarkdownAttachmentImportResult, Error>
    ) {
        guard let upload = uploads.removeValue(forKey: id) else { return }
        if case let .success(value) = result, let context {
            let source = context.document.markdown as NSString
            let range = source.range(of: upload.placeholder)
            if range.location != NSNotFound {
                let replacement = attachmentMarkdown(
                    kind: value.kind ?? kind,
                    alt: value.alt ?? cleanAttachmentAlt(upload.url),
                    reference: value.reference
                )
                _ = try? context.document.transact(MarkdownPluginTransaction(
                    edits: [MarkdownPluginTextEdit(range: range, text: replacement)],
                    label: "Resolve attachment", origin: name
                ))
            }
            onImported?(value, upload.url)
        } else if case let .failure(error) = result {
            removePlaceholder(upload)
            onError?(error, upload.url)
        }
        renderUploads()
    }

    private func renderUploads() {
        guard let context else { return }
        guard !uploads.isEmpty else { context.dismissPresentation("uploads"); return }
        let view = NativeAttachmentProgressView(uploads: Array(uploads.values)) { [weak self] id in
            guard let upload = self?.uploads.removeValue(forKey: id) else { return }
            upload.cancellation?.cancel()
            self?.removePlaceholder(upload)
            self?.renderUploads()
        }
        context.showPresentation(
            "uploads",
            options: MarkdownPluginPresentationOptions(
                view: view, anchor: .editor, placement: .below,
                dismissOnOutsideInteraction: false, restoreFocus: false
            )
        )
    }

    private func removePlaceholder(_ upload: NativeAttachmentUpload) {
        guard let context else { return }
        let source = context.document.markdown as NSString
        let range = source.range(of: upload.placeholder)
        if range.location != NSNotFound {
            _ = try? context.document.transact(MarkdownPluginTransaction(
                edits: [MarkdownPluginTextEdit(range: range, text: "")],
                label: "Remove attachment", origin: name
            ))
        }
    }
}

private final class NativeAttachmentUpload {
    let id: Int
    let url: URL
    let placeholder: String
    var progress = 0.0
    var cancellation: (any MarkdownAttachmentImportCancellation)?
    init(id: Int, url: URL, placeholder: String) {
        self.id = id; self.url = url; self.placeholder = placeholder
    }
}

private func attachmentKind(_ url: URL) -> MarkdownAttachmentKind {
    guard let type = UTType(filenameExtension: url.pathExtension) else { return .file }
    if type.conforms(to: .image) { return .image }
    if type.conforms(to: .movie) { return .video }
    if type.conforms(to: .audio) { return .audio }
    return .file
}

private func cleanAttachmentAlt(_ url: URL) -> String {
    url.deletingPathExtension().lastPathComponent
        .replacingOccurrences(of: "-", with: " ")
        .replacingOccurrences(of: "_", with: " ")
}

private func attachmentMarkdown(
    kind: MarkdownAttachmentKind, alt: String, reference: String
) -> String {
    let prefix = kind == .image ? "" : "\(kind.rawValue): "
    return "![\(prefix)\(alt.replacingOccurrences(of: "]", with: "\\]"))](\(reference))"
}

// Source-compatible journal names now point at the generic attachment pipeline.
public typealias JournalAttachmentKind = MarkdownAttachmentKind
public typealias JournalAttachmentImportResult = MarkdownAttachmentImportResult
public typealias JournalAttachmentImportCancellation = MarkdownAttachmentImportCancellation
public typealias JournalAttachmentImporting = MarkdownAttachmentImporting
public typealias JournalAttachments = MarkdownAttachments

#if os(macOS)
private final class NativeAttachmentProgressView: NSStackView {
    init(uploads: [NativeAttachmentUpload], cancel: @escaping (Int) -> Void) {
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 8
        edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        wantsLayer = true; layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        layer?.cornerRadius = 10
        addArrangedSubview(NSTextField(labelWithString: "Adding media"))
        for upload in uploads {
            let row = NSStackView(); row.orientation = .horizontal; row.spacing = 8
            let label = NSTextField(labelWithString: upload.url.lastPathComponent)
            label.lineBreakMode = .byTruncatingMiddle
            let progress = NSProgressIndicator(); progress.isIndeterminate = false
            progress.minValue = 0; progress.maxValue = 1; progress.doubleValue = upload.progress
            let button = ClosureButton(title: "Cancel") { cancel(upload.id) }
            row.addArrangedSubview(label); row.addArrangedSubview(progress); row.addArrangedSubview(button)
            addArrangedSubview(row)
        }
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not supported") }
}
private final class ClosureButton: NSButton {
    let closure: () -> Void
    init(title: String, closure: @escaping () -> Void) {
        self.closure = closure
        super.init(frame: .zero)
        self.title = title; target = self; action = #selector(run)
    }
    @objc func run() { closure() }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("not supported") }
}
#else
private final class NativeAttachmentProgressView: UIStackView {
    init(uploads: [NativeAttachmentUpload], cancel: @escaping (Int) -> Void) {
        super.init(frame: .zero)
        axis = .vertical; spacing = 8; isLayoutMarginsRelativeArrangement = true
        directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12)
        backgroundColor = .secondarySystemBackground; layer.cornerRadius = 10
        let title = UILabel(); title.text = "Adding media"; title.font = .preferredFont(forTextStyle: .headline)
        addArrangedSubview(title)
        for upload in uploads {
            let row = UIStackView(); row.axis = .horizontal; row.spacing = 8
            let label = UILabel(); label.text = upload.url.lastPathComponent; label.lineBreakMode = .byTruncatingMiddle
            let progress = UIProgressView(); progress.progress = Float(upload.progress)
            let button = UIButton(type: .system, primaryAction: UIAction(title: "Cancel") { _ in cancel(upload.id) })
            row.addArrangedSubview(label); row.addArrangedSubview(progress); row.addArrangedSubview(button)
            addArrangedSubview(row)
        }
    }
    @available(*, unavailable) required init(coder: NSCoder) { fatalError("not supported") }
}
#endif
