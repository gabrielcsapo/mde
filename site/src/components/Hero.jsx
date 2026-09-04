import { useEffect, useRef, useState } from 'react';
import { Link } from '../lib/router.jsx';
import { withBase } from '../lib/base.js';

const NATIVE_DEMOS = {
  ios: {
    tab: 'iPhone',
    deviceClass: 'hero-phone',
    video: withBase('/assets/ios-native-editor.mp4'),
    poster: withBase('/assets/ios-native-editor-poster.webp'),
    caption: 'Real UIKit + TextKit editing, powered by the same Rust core.',
    label: 'The native iOS editor typing a task list, link, Markdown table, and correcting text in real time.',
  },
  macos: {
    tab: 'Mac',
    deviceClass: 'hero-mac-window',
    video: withBase('/assets/macos-native-editor.mp4'),
    poster: withBase('/assets/macos-native-editor-poster.webp'),
    caption: 'Real AppKit + TextKit editing, powered by the same Rust core.',
    label: 'The native macOS editor typing a task list, link, Markdown table, and correcting text in real time.',
  },
};

/** The front page thesis: portable source on the left, native input in motion on the right. */
export default function Hero() {
  const videoRef = useRef(null);
  const [activeDevice, setActiveDevice] = useState('ios');
  const [reduceMotion, setReduceMotion] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [paused, setPaused] = useState(true);
  const [pausedFrame, setPausedFrame] = useState(null);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const respectMotionPreference = (event) => setReduceMotion(event.matches);

    media.addEventListener('change', respectMotionPreference);
    return () => media.removeEventListener('change', respectMotionPreference);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    let cancelled = false;
    setPaused(true);
    setPausedFrame(null);

    if (reduceMotion) {
      video.pause();
      return undefined;
    }

    const startPlayback = async () => {
      try {
        video.muted = true;
        await video.play();
      } catch {
        if (!cancelled) setPaused(true);
      }
    };

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      startPlayback();
    } else {
      video.addEventListener('loadeddata', startPlayback, { once: true });
    }

    return () => {
      cancelled = true;
      video.removeEventListener('loadeddata', startPlayback);
    };
  }, [activeDevice, reduceMotion]);

  const showPausedFrame = (video) => {
    let frame = null;
    if (video.currentTime > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(video, 0, 0);
          frame = canvas.toDataURL('image/jpeg', 0.9);
        }
      } catch {
        // The authored poster remains the reliable fallback if a browser blocks capture.
      }
    }
    setPausedFrame(frame);
    setPaused(true);
  };

  const toggleVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setPausedFrame(null);
      video.play().catch(() => setPaused(true));
    } else {
      video.pause();
    }
  };

  const selectDevice = (id) => {
    if (id === activeDevice) return;
    setPaused(true);
    setPausedFrame(null);
    setActiveDevice(id);
  };
  const demo = NATIVE_DEMOS[activeDevice];

  return (
    <header className="hero">
      <div className="hero-intro">
        <div className="hero-copy">
          <p className="eyebrow">One source · every screen</p>
          <h1 className="hero-title">
            <span className="hero-node" tabIndex={0}>
              <span className="hero-marker" aria-hidden="true">**</span>
              Markdown
              <span className="hero-marker" aria-hidden="true">**</span>
            </span>
            ,
            <span className="hero-title-accent">native everywhere.</span>
          </h1>
        </div>

        <div className="hero-pitch">
          <p className="lede hero-summary">
            One small Rust core keeps syntax, extensions, and undo consistent while every platform
            keeps the input, selection, spellcheck, and accessibility people already know.
          </p>

          <div className="hero-actions">
            <Link className="hero-action hero-action-primary" to="/docs/try">
              Try the editor
              <span aria-hidden="true">→</span>
            </Link>
            <Link className="hero-action hero-action-secondary" to="/docs/overview">
              Read the docs
            </Link>
          </div>

          <ul className="hero-platform-list" aria-label="Supported integrations">
            <li>JS</li>
            <li>React</li>
            <li>iOS</li>
            <li>macOS</li>
          </ul>
        </div>
      </div>

      <figure className="hero-native-demo" aria-labelledby="native-demo-caption">
        <div className="hero-demo-bar">
          <div className="hero-device-tabs" role="tablist" aria-label="Native app capture">
            {Object.entries(NATIVE_DEMOS).map(([id, item]) => (
              <button
                id={`native-demo-${id}-tab`}
                key={id}
                type="button"
                role="tab"
                aria-controls="native-demo-panel"
                aria-selected={activeDevice === id}
                onClick={() => selectDevice(id)}
              >
                {item.tab}
              </button>
            ))}
          </div>
          <span>real app capture</span>
        </div>

        <div
          className="hero-demo-stage"
          id="native-demo-panel"
          role="tabpanel"
          aria-labelledby={`native-demo-${activeDevice}-tab`}
        >
          <div className={demo.deviceClass}>
            <video
              key={activeDevice}
              ref={videoRef}
              autoPlay={!reduceMotion}
              muted
              loop
              playsInline
              preload="auto"
              poster={demo.poster}
              onPlaying={() => {
                setPausedFrame(null);
                setPaused(false);
              }}
              onPause={(event) => showPausedFrame(event.currentTarget)}
              onError={() => {
                setPausedFrame(null);
                setPaused(true);
              }}
              aria-label={demo.label}
            >
              <source src={demo.video} type="video/mp4" />
            </video>
            {paused && (
              <img
                className="hero-demo-paused-frame"
                src={pausedFrame || demo.poster}
                alt=""
                aria-hidden="true"
              />
            )}
          </div>

          <button
            className="hero-demo-control"
            type="button"
            onClick={toggleVideo}
            aria-label={`${paused ? 'Play' : 'Pause'} ${demo.tab} editor demo`}
          >
            <span aria-hidden="true">{paused ? '▶' : 'Ⅱ'}</span>
            {paused ? 'Play' : 'Pause'}
          </button>
        </div>

        <figcaption id="native-demo-caption">
          <strong>Native input. Portable source.</strong>
          <span>{demo.caption}</span>
        </figcaption>
      </figure>
    </header>
  );
}
