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
    private let lock = NSLock()
    private(set) var hits = 0
    private(set) var generations = 0

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(
            for: .cachesDirectory, in: .userDomainMask
        )[0].appendingPathComponent("MDEMediaPreviews", isDirectory: true)
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
            lock.withLock { hits += 1 }
            return image
        }
        guard let image = generate() else { return nil }
        lock.withLock { generations += 1 }
        Self.write(image, to: target)
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
        guard let track = asset.tracks(withMediaType: .audio).first,
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
