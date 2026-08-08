import Foundation
import MDEditorUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Resolves references against a directory on disk, asynchronously.
///
/// This is the whole point of `ResourceResolver`: the note contains
/// `![a chart](chart.png)` — twenty-six characters — and the megabytes live wherever
/// the host keeps them. The same shape works for a remote URL, a video, a
/// content-addressed blob store, or a document previewer; only this class changes.
public final class DiskResourceResolver: ResourceResolver {
    private let root: URL
    private let queue = DispatchQueue(label: "dev.mde.resources", qos: .userInitiated)

    public init(root: URL) {
        self.root = root
    }

    public func resolve(
        _ request: ResourceRequest,
        deliver: @escaping (ResourceState) -> Void
    ) -> ResourceState {
        let url = root.appendingPathComponent(request.reference)
        let width = request.fittingWidth

        queue.async {
            let state = Self.load(url: url, reference: request.reference, width: width)
            DispatchQueue.main.async { deliver(state) }
        }
        // Loading is genuinely off the main thread — the editor reserves space and
        // repaints just this node when the bytes land.
        return .loading
    }

    public func reservedSize(_ request: ResourceRequest) -> CGSize {
        // A real host would read dimensions from a sidecar or the filename. Reserving
        // *something* plausible is what stops the document jumping on load.
        let width = min(request.fittingWidth, 320)
        return isImage(request.reference)
            ? CGSize(width: width, height: width * 0.6)
            : CGSize(width: width, height: 56)
    }

    private func isImage(_ reference: String) -> Bool {
        ["png", "jpg", "jpeg", "gif", "heic"].contains((reference as NSString).pathExtension.lowercased())
    }

    private static func load(url: URL, reference: String, width: CGFloat) -> ResourceState {
        guard let data = try? Data(contentsOf: url) else {
            return .failed("missing \((reference as NSString).lastPathComponent)")
        }

        #if os(macOS)
        if let image = NSImage(data: data) {
            return .ready(ImageResourceView(image: image, maxWidth: width))
        }
        #else
        if let image = UIImage(data: data) {
            return .ready(ImageResourceView(image: image, maxWidth: width))
        }
        #endif

        // Not an image: show what we know about it rather than pretending to render.
        let name = (reference as NSString).lastPathComponent
        let size = ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
        return .ready(CardView(text: "📄 \(name) · \(size)", tone: .info))
    }
}

/// Displays a resolved image, scaled to fit the text column.
///
/// Its size is published as `intrinsicContentSize` rather than as width/height
/// constraints. The editor hosts a widget by frame so that content with its own layout
/// still works; self-imposed size constraints fight that and the image renders as a
/// blank gap with no error anywhere.
final class ImageResourceView: PlatformView {
    private let target: CGSize

    init(image: PlatformImage, maxWidth: CGFloat) {
        let cap = maxWidth > 0 ? maxWidth : 320
        let scale = min(1, cap / max(image.size.width, 1))
        target = CGSize(
            width: floor(image.size.width * scale),
            height: floor(image.size.height * scale)
        )
        super.init(frame: CGRect(origin: .zero, size: target))

        #if os(macOS)
        let view = NSImageView(image: image)
        view.imageScaling = .scaleProportionallyUpOrDown
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
        view.autoresizingMask = [.width, .height]
        #else
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFit
        layer.cornerRadius = 8
        clipsToBounds = true
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        #endif

        view.frame = bounds
        addSubview(view)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override var intrinsicContentSize: CGSize { target }
}

#if os(macOS)
typealias PlatformImage = NSImage
#else
typealias PlatformImage = UIImage
#endif

/// Writes the sample assets the reference document points at, so the demo resolves
/// real files rather than faking it.
public enum SampleAssets {
    public static func install() -> URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("assets", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let chart = dir.appendingPathComponent("chart.png")
        if !FileManager.default.fileExists(atPath: chart.path),
           let data = makeChartPNG() {
            try? data.write(to: chart)
        }

        let photo = dir.appendingPathComponent("photo.png")
        if !FileManager.default.fileExists(atPath: photo.path),
           let data = makePhotoPNG() {
            try? data.write(to: photo)
        }

        let spec = dir.appendingPathComponent("spec.pdf")
        if !FileManager.default.fileExists(atPath: spec.path) {
            try? Data(repeating: 0x25, count: 48_000).write(to: spec)
        }
        return dir
    }

    /// A simple bar chart, drawn rather than bundled.
    private static func makeChartPNG() -> Data? {
        let size = CGSize(width: 640, height: 360)
        let bars: [CGFloat] = [0.35, 0.62, 0.48, 0.81, 0.55, 0.93]

        guard let context = CGContext(
            data: nil,
            width: Int(size.width),
            height: Int(size.height),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        context.setFillColor(red: 0.09, green: 0.10, blue: 0.13, alpha: 1)
        context.fill(CGRect(origin: .zero, size: size))

        let inset: CGFloat = 40
        let slot = (size.width - inset * 2) / CGFloat(bars.count)
        for (i, value) in bars.enumerated() {
            let height = (size.height - inset * 2) * value
            let rect = CGRect(
                x: inset + slot * CGFloat(i) + slot * 0.18,
                y: inset,
                width: slot * 0.64,
                height: height
            )
            context.setFillColor(red: 0.31, green: 0.55, blue: 0.95, alpha: 1)
            context.fill(rect)
        }

        guard let image = context.makeImage() else { return nil }
        #if os(macOS)
        let rep = NSBitmapImageRep(cgImage: image)
        return rep.representation(using: .png, properties: [:])
        #else
        return UIImage(cgImage: image).pngData()
        #endif
    }

    /// A distinct second image makes cross-platform captures prove that references are
    /// resolved individually rather than painting one hard-coded thumbnail everywhere.
    private static func makePhotoPNG() -> Data? {
        let size = CGSize(width: 640, height: 360)
        guard let context = CGContext(
            data: nil,
            width: Int(size.width),
            height: Int(size.height),
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        let colors = [
            CGColor(red: 0.18, green: 0.42, blue: 0.72, alpha: 1),
            CGColor(red: 0.70, green: 0.86, blue: 0.96, alpha: 1),
        ] as CFArray
        if let gradient = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]
        ) {
            context.drawLinearGradient(
                gradient, start: CGPoint(x: 0, y: size.height), end: .zero, options: []
            )
        }
        context.setFillColor(red: 1, green: 0.78, blue: 0.30, alpha: 1)
        context.fillEllipse(in: CGRect(x: 470, y: 245, width: 64, height: 64))
        context.setFillColor(red: 0.15, green: 0.32, blue: 0.28, alpha: 1)
        context.beginPath()
        context.move(to: CGPoint(x: 0, y: 0))
        context.addLine(to: CGPoint(x: 225, y: 225))
        context.addLine(to: CGPoint(x: 390, y: 45))
        context.addLine(to: CGPoint(x: 640, y: 215))
        context.addLine(to: CGPoint(x: 640, y: 0))
        context.closePath()
        context.fillPath()

        guard let image = context.makeImage() else { return nil }
        #if os(macOS)
        return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        #else
        return UIImage(cgImage: image).pngData()
        #endif
    }
}
