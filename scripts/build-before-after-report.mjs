import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const reports = resolve(root, 'reports');
const imageData = (name) =>
  `data:image/png;base64,${readFileSync(resolve(reports, name)).toString('base64')}`;
const assetData = (path, mime) =>
  `data:${mime};base64,${readFileSync(resolve(root, path)).toString('base64')}`;
const images = {
  beforeHome: imageData('before-home.png'),
  afterHome: imageData('after-home.png'),
  beforeInstall: imageData('before-install.png'),
  afterInstall: imageData('after-install.png'),
  afterMobile: imageData('after-mobile.png'),
};
const nativeVideo = assetData('site/assets/ios-native-editor.mp4', 'video/mp4');
const nativePoster = assetData('site/assets/ios-native-editor-poster.webp', 'image/webp');
const macVideo = assetData('site/assets/macos-native-editor.mp4', 'video/mp4');
const macPoster = assetData('site/assets/macos-native-editor-poster.webp', 'image/webp');
const iosVideoKB = Math.round(
  statSync(resolve(root, 'site/assets/ios-native-editor.mp4')).size / 1024,
);
const macVideoKB = Math.round(
  statSync(resolve(root, 'site/assets/macos-native-editor.mp4')).size / 1024,
);
const videoDimensions = (path) => execFileSync(
  'ffprobe',
  [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x', resolve(root, path),
  ],
  { encoding: 'utf8' },
).trim().replace('x', '×');
const iosVideoDimensions = videoDimensions('site/assets/ios-native-editor.mp4');
const macVideoDimensions = videoDimensions('site/assets/macos-native-editor.mp4');

const css = `
:root{color-scheme:dark;--paper:#0d0e0c;--panel:#141613;--ink:#f0f1ec;--muted:#a7aaa2;--rule:#2a2d28;--accent:#d9ff43}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 system-ui,sans-serif}
main{width:min(1180px,calc(100% - 36px));margin:auto;padding:72px 0 96px}
header,.section-head{display:grid;grid-template-columns:1.2fr .8fr;gap:48px;align-items:end}
header{padding-bottom:48px;border-bottom:1px solid var(--rule)}
.eyebrow{margin:0 0 18px;color:var(--accent);font:600 11px/1.2 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase}
h1,h2,h3{margin:0;font-weight:520;letter-spacing:-.035em}
h1{max-width:12ch;font:440 clamp(3.3rem,8vw,7.4rem)/.92 ui-monospace,monospace}
h2{font:460 clamp(2rem,4vw,3.6rem)/1.03 ui-monospace,monospace}
h3{font-size:1.05rem;letter-spacing:-.01em}p{margin:0}.intro,.section-head p{color:var(--muted)}
.status{display:inline-flex;align-items:center;gap:9px;margin-top:24px;padding:8px 11px;border:1px solid var(--rule);border-radius:999px;font:600 11px/1 ui-monospace,monospace;text-transform:uppercase}
.status:before{content:'';width:7px;height:7px;border-radius:50%;background:var(--accent)}
section{padding:64px 0;border-bottom:1px solid var(--rule)}.section-head{grid-template-columns:.7fr 1fr;margin-bottom:30px}
.comparison{display:grid;grid-template-columns:1fr 1fr;gap:18px}
figure{margin:0;overflow:hidden;border:1px solid var(--rule);border-radius:12px;background:var(--panel)}figure img{display:block;width:100%}
figcaption{display:flex;justify-content:space-between;padding:13px 16px;border-top:1px solid var(--rule);color:var(--muted);font:600 11px/1.3 ui-monospace,monospace;text-transform:uppercase}figcaption strong{color:var(--ink)}
.native-proof{display:grid;grid-template-columns:minmax(260px,360px) 1fr;gap:54px;align-items:center}.native-film{margin:auto;overflow:hidden;border:1px solid var(--rule);border-radius:42px;background:#000;box-shadow:0 32px 80px #0008}.native-film video{display:block;width:100%;aspect-ratio:432/940;background:#000}.native-copy>p{margin-top:18px;color:var(--muted)}.mac-film{margin-top:30px;border-radius:14px;box-shadow:0 24px 60px #0006}.mac-film video{display:block;width:100%;aspect-ratio:650/390;background:#000}
.facts{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--rule);border-radius:12px;overflow:hidden}.fact{padding:22px}.fact+.fact{border-left:1px solid var(--rule)}
.fact small{display:block;margin-bottom:12px;color:var(--accent);font:600 10px/1 ui-monospace,monospace;text-transform:uppercase}.fact p{margin-top:8px;color:var(--muted)}
table{width:100%;border-collapse:collapse;border:1px solid var(--rule)}th,td{padding:15px 17px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}th{width:26%;color:var(--muted);font:600 10px/1.3 ui-monospace,monospace;text-transform:uppercase}tr:last-child th,tr:last-child td{border-bottom:0}
code{color:var(--accent);font-family:ui-monospace,monospace}.mobile{display:grid;grid-template-columns:390px 1fr;gap:36px;align-items:center}.mobile figure{max-width:390px}
.checklist{display:grid;gap:12px;margin:22px 0 0;padding:0;list-style:none}.checklist li{position:relative;padding-left:28px;color:var(--muted)}.checklist li:before{content:'✓';position:absolute;left:0;color:var(--accent)}
.boundary{margin-top:28px;padding:18px 20px;border-left:3px solid var(--accent);background:var(--panel);color:var(--muted)}
footer{display:flex;justify-content:space-between;gap:24px;padding-top:26px;color:var(--muted);font:11px/1.5 ui-monospace,monospace}
@media(max-width:760px){main{width:calc(100% - 24px);padding-top:38px}header,.section-head,.comparison,.mobile,.native-proof{grid-template-columns:1fr}.facts{grid-template-columns:1fr}.fact+.fact{border-left:0;border-top:1px solid var(--rule)}h1{font-size:clamp(2.8rem,16vw,5.2rem)}footer{display:block}}
@media print{:root{color-scheme:light;--paper:#fff;--panel:#f5f5f2;--ink:#10110f;--muted:#565951;--rule:#d9dbd5;--accent:#435e00}main{width:100%;padding:24px}}
`;

const figure = (src, alt, label, note) =>
  `<figure><img src="${src}" alt="${alt}"><figcaption><strong>${label}</strong><span>${note}</span></figcaption></figure>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>@mdink · before and after</title><style>${css}</style></head><body><main>
<header><div><p class="eyebrow">@mdink · visual and release-readiness report</p><h1>Before → after.</h1></div><div><p class="intro">A self-contained record of the docs redesign, runnable onboarding, package release lane, and real native editing films completed on 26 August 2026.</p><span class="status">Implementation verified</span></div></header>
<section><div class="section-head"><h2>A clearer first impression.</h2><p>The original hero explained the product, but looked like a conventional developer landing page. The new direction uses Markdown source as its visual language: mono typography, structural rules, and live native proof.</p></div><div class="comparison">${figure(images.beforeHome,'Original mde homepage','Before','committed baseline · 8205d25')}${figure(images.afterHome,'Redesigned @mdink homepage with native editor film','After','live native edit · desktop hero')}</div></section>
<section><div class="native-proof"><figure class="native-film"><video controls autoplay muted loop playsinline poster="${nativePoster}" aria-label="The real iOS editor typing and editing a complex Markdown document"><source src="${nativeVideo}" type="video/mp4"></video></figure><div class="native-copy"><p class="eyebrow">Static screenshot → two real native edits</p><h2>The proof now moves on iPhone and Mac.</h2><p>These paired 14-second recordings run the same Markdown through the production UIKit/TextKit and AppKit/TextKit editors. Each types through its ordinary native input path, builds a task list and table, selects a deliberate typo, corrects it, and applies the public bold command.</p><ul class="checklist"><li>Real Swift app captures—not browser recreations.</li><li>Real incremental edits—not pre-rendered typewriter overlays.</li><li>One compact iPhone/Mac switcher keeps both films legible.</li><li>Muted, looping, inline playback with controls and poster fallbacks.</li></ul><figure class="mac-film"><video controls muted loop playsinline poster="${macPoster}" aria-label="The real macOS editor typing and editing the same complex Markdown document"><source src="${macVideo}" type="video/mp4"></video><figcaption><strong>Mac</strong><span>AppKit · TextKit · same source</span></figcaption></figure></div></div></section>
<section><div class="section-head"><h2>From repository tour to runnable start.</h2><p>The old guide began with build tooling, had no registry command, and used host-only variables. The new guide opens with the integration choice and gives complete Web, React, and Swift paths.</p></div><div class="comparison">${figure(images.beforeInstall,'Original install guide','Before','checkout required · placeholders')}${figure(images.afterInstall,'Rewritten install guide','After','Web · React · Swift quickstarts')}</div></section>
<section><div class="section-head"><h2>What changed.</h2><p>The release surface and documentation now describe the same package boundaries.</p></div><div class="facts"><article class="fact"><small>Onboarding</small><h3>Runnable snippets</h3><p><code>pnpm add @mdink/web</code>, React + Wasm loading, and minimal <code>MarkdownTextView()</code>.</p></article><article class="fact"><small>npm</small><h3>Changesets + OIDC</h3><p>Fixed versions, changelogs, version PRs, packing, trusted publishing, tags, and releases.</p></article><article class="fact"><small>Swift</small><h3>Release preparation</h3><p>One command prepares the XCFramework archive, checksum, and remote manifest after the repository URL exists.</p></article></div></section>
<section><div class="section-head"><h2>Verification record.</h2><p>Checks ran against production builds and rendered pages—not only source files.</p></div><table><tr><th>Production build</th><td>Site, Rust/Wasm core, and all four npm packages built successfully.</td></tr><tr><th>Native films</th><td>Both high-resolution H.264 captures were verified frame by frame at 30 fps and about 14 seconds: iPhone ${iosVideoDimensions} / ${iosVideoKB} KB; Mac ${macVideoDimensions} / ${macVideoKB} KB.</td></tr><tr><th>Web suite</th><td>154 tests passed; 3 intentionally skipped. Verified pages logged no warnings or errors.</td></tr><tr><th>Swift suite</th><td>161 tests passed; 17 opt-in benchmarks skipped. The package manifest and native renderer built from a clean cache.</td></tr><tr><th>npm artifacts</th><td>Four tarballs validated for runtime files, declarations, Wasm/CSS, README, changelog, license, public access, provenance, and resolved internal ranges.</td></tr><tr><th>Docs content</th><td>Web and React install commands found; zero starter placeholders or misspelled vendor paths remained.</td></tr><tr><th>Responsive layout</th><td>1280 px and 390 px viewports verified; the two-platform player moves from the hero’s right side to a single-column mobile stack.</td></tr></table></section>
<section><div class="mobile">${figure(images.afterMobile,'Redesigned mobile homepage with the iPhone and Mac player stacked below its actions','Mobile','390 × 844 verified')}<div><p class="eyebrow">Responsive proof</p><h2>The hierarchy survives the small screen.</h2><ul class="checklist"><li>Headline stays readable without clipping.</li><li>Calls to action become full-width tap targets.</li><li>The iPhone/Mac player stacks below the platform list.</li><li>Both native tabs remain visible and tappable.</li><li>Document width matches the viewport.</li></ul></div></div></section>
<section><div class="section-head"><h2>Release boundary.</h2><p>The checkout is implementation-ready; identity-bearing account settings remain external.</p></div><ul class="checklist"><li>Connect the final GitHub repository and add its exact package metadata.</li><li>Confirm ownership of the <code>@mdink</code> npm scope and configure <code>release.yml</code> as trusted publisher.</li><li>Prepare the first Swift release using that owner/repository slug and attach its archive.</li></ul><p class="boundary">No package was published and no repository was created. The checked-in workflow and release guide make the remaining handoff explicit.</p></section>
<footer><span>@mdink · before/after report</span><span>Baseline 8205d25 · current working tree · 2026-08-26</span></footer>
</main></body></html>`;

writeFileSync(resolve(reports, 'before-after.html'), html);
console.log(`Wrote ${resolve(reports, 'before-after.html')}`);
