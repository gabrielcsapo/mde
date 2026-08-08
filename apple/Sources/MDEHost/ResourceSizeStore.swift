import CoreGraphics
import Foundation

/// Persists the sizes the editor learned for resolved resources.
///
/// The editor measures whatever resolves; keeping that across launches is what stops the
/// document shifting a second time. `reservedSize` then only has to guess for an asset
/// this host has genuinely never seen.
public enum ResourceSizeStore {
    private static let key = "mde.resourceSizes"

    public static func load() -> [String: CGSize] {
        guard let raw = UserDefaults.standard.dictionary(forKey: key) else { return [:] }
        return raw.reduce(into: [:]) { out, pair in
            guard let wh = pair.value as? [Double], wh.count == 2 else { return }
            out[pair.key] = CGSize(width: wh[0], height: wh[1])
        }
    }

    public static func save(_ sizes: [String: CGSize]) {
        let raw = sizes.mapValues { [Double($0.width), Double($0.height)] }
        UserDefaults.standard.set(raw, forKey: key)
    }
}
