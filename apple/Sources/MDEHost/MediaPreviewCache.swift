import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum MediaPreviewKind: String { case videoPoster, audioWaveform }

/// Persistent generated previews keyed by file identity and requested pixel width.
/// The cache stores compact PNGs, never live AVFoundation objects, so reopening a
/// journal does not reopen every media decoder merely to draw its timeline.
final class MediaPreviewCache {
    private let directory: URL
    private let maximumBytes: Int64
    private let lock = NSLock()
    private struct Entry { let bytes: Int64; var lastAccess: Date }
    private var inventoryLoaded = false
    private var entries = [URL: Entry]()
    private var storedBytes: Int64 = 0
    private(set) var hits = 0
    private(set) var generations = 0

    init(directory: URL? = nil, maximumBytes: Int64 = 128 * 1024 * 1024) {
        self.directory = directory ?? FileManager.default.urls(
            for: .cachesDirectory, in: .userDomainMask
        )[0].appendingPathComponent("MDEMediaPreviews", isDirectory: true)
        self.maximumBytes = max(1, maximumBytes)
        try? FileManager.default.createDirectory(
            at: self.directory, withIntermediateDirectories: true
        )
    }

    func preview(
        for source: URL,
        kind: MediaPreviewKind,
        maximumPixels: Int,
        generate: () -> CGImage?
    ) -> CGImage? {
        let target = fileURL(for: source, kind: kind, maximumPixels: maximumPixels)
        if let image = Self.read(target) {
            touch(target)
            lock.withLock { hits += 1 }
            return image
        }
        guard let image = generate() else { return nil }
        lock.withLock { generations += 1 }
        Self.write(image, to: target)
        recordAndTrim(target)
        return image
    }

    private func fileURL(
        for source: URL,
        kind: MediaPreviewKind,
        maximumPixels: Int
    ) -> URL {
        let values = try? source.resourceValues(forKeys: [
            .fileSizeKey, .contentModificationDateKey,
        ])
        let identity = [
            source.standardizedFileURL.path,
            String(values?.fileSize ?? 0),
            String(values?.contentModificationDate?.timeIntervalSince1970 ?? 0),
            kind.rawValue,
            String(maximumPixels),
        ].joined(separator: "|")
        return directory.appendingPathComponent(Self.stableHash(identity) + ".png")
    }

    private static func stableHash(_ value: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash &*= 0x100000001b3
        }
        return String(hash, radix: 16)
    }

    private static func read(_ url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, [
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    }

    private static func write(_ image: CGImage, to url: URL) {
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.png.identifier as CFString, 1, nil
        ) else { return }
        CGImageDestinationAddImage(destination, image, nil)
        _ = CGImageDestinationFinalize(destination)
    }

    private func loadInventoryLocked() {
        guard !inventoryLoaded else { return }
        inventoryLoaded = true
        let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else { return }
        for url in files {
            guard let values = try? url.resourceValues(forKeys: keys) else { continue }
            let entry = Entry(
                bytes: Int64(values.fileSize ?? 0),
                lastAccess: values.contentModificationDate ?? .distantPast
            )
            entries[url] = entry
            storedBytes += entry.bytes
        }
    }

    private func touch(_ url: URL) {
        let now = Date()
        try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: url.path)
        lock.withLock {
            loadInventoryLocked()
            if var entry = entries[url] {
                entry.lastAccess = now
                entries[url] = entry
            }
        }
    }

    private func recordAndTrim(_ url: URL) {
        let removals: [URL] = lock.withLock {
            loadInventoryLocked()
            if let previous = entries[url] { storedBytes -= previous.bytes }
            let values = try? url.resourceValues(forKeys: [.fileSizeKey])
            let entry = Entry(bytes: Int64(values?.fileSize ?? 0), lastAccess: Date())
            entries[url] = entry
            storedBytes += entry.bytes
            var removed = [URL]()
            while storedBytes > maximumBytes,
                  let oldest = entries.min(by: { $0.value.lastAccess < $1.value.lastAccess }) {
                entries.removeValue(forKey: oldest.key)
                storedBytes -= oldest.value.bytes
                removed.append(oldest.key)
            }
            return removed
        }
        removals.forEach { try? FileManager.default.removeItem(at: $0) }
    }
}

protocol MediaPreviewGenerating {
    func videoPoster(url: URL, maximumPixels: Int) -> CGImage?
    func audioWaveform(url: URL, maximumPixels: Int) -> CGImage?
}

struct MediaPreviewGenerator: MediaPreviewGenerating {
    func videoPoster(url: URL, maximumPixels: Int) -> CGImage? {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maximumPixels, height: maximumPixels)
        generator.requestedTimeToleranceBefore = .positiveInfinity
        generator.requestedTimeToleranceAfter = .positiveInfinity
        return try? generator.copyCGImage(at: .zero, actualTime: nil)
    }

    func audioWaveform(url: URL, maximumPixels: Int) -> CGImage? {
        let asset = AVURLAsset(url: url)
        let loaded = LockedAudioTrack()
        let ready = DispatchSemaphore(value: 0)
        Task.detached {
            loaded.value = try? await asset.loadTracks(withMediaType: .audio).first
            ready.signal()
        }
        ready.wait()
        guard let track = loaded.value,
              let reader = try? AVAssetReader(asset: asset)
        else { return nil }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return nil }
        reader.add(output)
        guard reader.startReading() else { return nil }

        let columns = max(64, min(maximumPixels, 1_024))
        var peaks = [Int16](repeating: 0, count: columns)
        var sampleIndex = 0
        // Bound analysis work. A preview should never decode an entire multi-hour file.
        let maximumSamples = columns * 2_048
        while sampleIndex < maximumSamples, let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetDataBuffer(sample) else { continue }
            var length = 0
            var pointer: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(
                buffer, atOffset: 0, lengthAtOffsetOut: nil,
                totalLengthOut: &length, dataPointerOut: &pointer
            ) == kCMBlockBufferNoErr, let pointer else { continue }
            let values = UnsafeRawPointer(pointer).bindMemory(to: Int16.self, capacity: length / 2)
            for index in 0 ..< length / 2 where sampleIndex < maximumSamples {
                let column = min(columns - 1, sampleIndex * columns / maximumSamples)
                let magnitude = values[index] == Int16.min ? Int16.max : abs(values[index])
                peaks[column] = max(peaks[column], magnitude)
                sampleIndex += 1
            }
        }
        reader.cancelReading()

        let height = 96
        guard let context = CGContext(
            data: nil, width: columns, height: height, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.setFillColor(CGColor(red: 0.08, green: 0.10, blue: 0.14, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: columns, height: height))
        context.setStrokeColor(CGColor(red: 0.28, green: 0.58, blue: 0.98, alpha: 1))
        context.setLineWidth(1)
        for (column, peak) in peaks.enumerated() {
            let amplitude = max(1, CGFloat(peak) / CGFloat(Int16.max) * CGFloat(height - 8) / 2)
            context.move(to: CGPoint(x: CGFloat(column), y: CGFloat(height) / 2 - amplitude))
            context.addLine(to: CGPoint(x: CGFloat(column), y: CGFloat(height) / 2 + amplitude))
        }
        context.strokePath()
        return context.makeImage()
    }
}

private final class LockedAudioTrack: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: AVAssetTrack?

    var value: AVAssetTrack? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
