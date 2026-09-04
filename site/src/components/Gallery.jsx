import { useEffect, useState } from 'react';
import { withBase } from '../lib/base.js';

// `assets/manifest.json` is written by the capture tooling and is the only authority on
// what exists. It is read at runtime, not imported, so a fresh capture changes the
// gallery without rebuilding the site. Assets may be missing entirely, or partially — a
// capture can fail — so nothing here is hard-coded: unknown platforms still render,
// listed-but-unloadable files drop out, and an empty result degrades to a placeholder
// rather than a row of broken images.

const PLATFORM_LABELS = { ios: 'iOS', macos: 'macOS' };

export default function Gallery() {
  const [assets, setAssets] = useState([]);
  // Files whose media element reported an error. A `Set` in state rather than DOM
  // removal: the render is then a pure function of "what the manifest lists" minus
  // "what would not load", which is the same outcome without mutating the tree.
  const [failed, setFailed] = useState(() => new Set());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(withBase('/assets/manifest.json'), { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (live && Array.isArray(data?.assets)) {
          setAssets(data.assets.filter((a) => a && typeof a.file === 'string' && a.file));
        }
      } catch {
        // No manifest yet. That is a normal state while captures are being generated.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const usable = assets.filter((a) => !failed.has(a.file));
  if (usable.length === 0) return <Placeholder />;

  // Group in first-seen order so the manifest controls both which platforms appear and
  // the order within each.
  const groups = new Map();
  for (const a of usable) {
    const key = typeof a.platform === 'string' && a.platform ? a.platform : 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const onFail = (file) =>
    setFailed((prev) => {
      const next = new Set(prev);
      next.add(file);
      return next;
    });

  return (
    <div className="gallery">
      {[...groups].map(([platform, items]) => (
        <div className={`platform platform-${platform}`} key={platform}>
          <h3>{PLATFORM_LABELS[platform] ?? platform}</h3>
          <div className="shots">
            {items.map((item) => (
              <Shot key={item.file} item={item} onFail={onFail} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Shot({ item, onFail }) {
  const src = withBase(`/assets/${item.file}`);
  const caption = item.caption ?? item.name;
  const isVideo = item.kind === 'video';

  return (
    <figure>
      <div className="frame">
        {isVideo ? (
          <>
            <span className="badge">screencast</span>
            <video
              src={src}
              muted
              loop
              autoPlay
              controls
              playsInline
              preload="metadata"
              onError={() => onFail(item.file)}
            />
          </>
        ) : (
          <img
            src={src}
            alt={item.caption ?? item.name ?? ''}
            decoding="async"
            onError={() => onFail(item.file)}
            /* Deliberately not `loading="lazy"`: a lazily loaded file that does not
               exist only fails when it scrolls into view, so the visitor sees a broken
               image first and it disappearing second. The gallery is a handful of
               files; load them now. */
          />
        )}
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function Placeholder() {
  return (
    <div className="placeholder">
      <p>iOS and macOS examples are unavailable in this preview.</p>
    </div>
  );
}
