//! Per-keystroke cost of the core, measured rather than assumed.
//!
//! DESIGN §2.2 bounds reparsing to a safe region on ordinary keystrokes and falls back
//! to a full parse for structural edits. This prices the complete edit path and the
//! fallback stages independently so both claims keep a number attached to them.
//!
//! No benchmarking framework on purpose: the core has exactly three dependencies and
//! adding a fourth to time four function calls is a poor trade. `Instant` plus a median
//! over a fixed iteration count is enough resolution for costs measured in hundreds of
//! microseconds, and it runs anywhere `cargo run` does.
//!
//! ```text
//! cargo run --release --example bench -p mde-core
//! cargo run --release --example bench -p mde-core -- --dump target/bench-corpus
//! ```
//!
//! `--dump` writes the generated documents out so the Swift renderer benchmarks measure
//! the *same* bytes. Two layers reporting timings for two different corpora cannot be
//! added together, and the end-to-end keystroke budget is exactly that sum.
//!
//! Note the release profile this builds under is the shipping one (`opt-level = "z"`,
//! LTO): the whole point is to measure what Apple actually links against, not a faster
//! configuration nobody runs.

use mde_core::decorate::{self, Built};
use mde_core::diff;
use mde_core::text::{Edit, Text};
use mde_core::{Engine, Kind, LayerSpan, Registry, Selection};
use std::collections::HashMap;
use std::hint::black_box;
use std::time::{Duration, Instant};

/// The manifest from DESIGN §5, verbatim. Extension rules run on every reparse, so
/// benchmarking without them would flatter the inline scan.
const MANIFEST: &str = r#"
[[block]]
name   = "callout"
syntax = { kind = "fence", info = "callout" }
render = "block_widget"
reveal = "caret_in_block"

[[block]]
name   = "chart"
syntax = { kind = "directive", marker = ":::", name = "chart" }
render = "block_widget"
reveal = "caret_in_block"

[[inline]]
name   = "mention"
syntax = { kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }
render = "inline_widget"
reveal = "caret_in_node"

[[inline]]
name   = "wikilink"
syntax = { kind = "delimited", open = "[[", close = "]]" }
render = "style"
reveal = "caret_in_node"
"#;

const SIZES: &[(&str, usize)] = &[
    ("10 KB", 10 * 1024),
    ("100 KB", 100 * 1024),
    ("500 KB", 500 * 1024),
    ("1 MB", 1024 * 1024),
    ("5 MB", 5 * 1024 * 1024),
];

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/// A document of one giant paragraph would measure the parser's best case and nothing
/// else. These are the constructs the editor actually decorates — every one of them
/// produces decorations, and several produce widgets, which is where the renderer cost
/// lives.
///
/// `n` varies the prose so node sources stay mostly distinct. That matters: `node_key`
/// disambiguates byte-identical siblings by ordinal (DESIGN §3.3), so a corpus of
/// repeated identical blocks would understate key churn in one direction and overstate
/// it in the other.
fn block(n: usize) -> String {
    match n % 10 {
        0 => format!("## Section {n}: the {} report\n\n", word(n)),
        1 => format!(
            "The {} pipeline is **fully instrumented** now, though the *{}* stage still \
             needs work. Run `mde bench --size {n}` and read [the notes](docs/note-{n}.md) \
             before you ping @reviewer-{n} about it. See also [[design note {n}]].\n\n",
            word(n),
            word(n + 3)
        ),
        2 => format!(
            "- first {} item\n- second item with **emphasis {n}**\n- third item linking \
             [out](https://example.dev/{n})\n- fourth {} item\n\n",
            word(n),
            word(n + 1)
        ),
        3 => format!(
            "- [ ] draft the {} section\n- [x] land the {n} migration\n- [ ] chase @owner-{n}\n\n",
            word(n)
        ),
        4 => format!(
            "> The {} constraint is not negotiable.\n> It is what keeps offsets honest ({n}).\n\n",
            word(n)
        ),
        5 => format!(
            "```rust\nfn stage_{n}(input: &str) -> usize {{\n    input.len() + {n}\n}}\n```\n\n"
        ),
        6 => format!("```callout warning\nWatch the {} budget in stage {n}.\n```\n\n", word(n)),
        7 => format!(
            "![{} diagram](assets/diagram-{n}.png)\n\nThe diagram above shows stage {n}. \
             Compare it with [the {} spec](specs/{n}.pdf).\n\n",
            word(n),
            word(n + 2)
        ),
        8 => format!(":::chart\nbars: {n}\nlabel: {}\n:::\n\n", word(n)),
        // Non-ASCII on purpose: every emitted offset crosses a UTF-8 -> UTF-16
        // conversion (DESIGN §3.2), and an all-ASCII corpus makes that conversion look
        // free when the surrogate handling is the part that costs.
        _ => format!(
            "Le résumé de l'étape {n} — 段階 {n} の概要 — is **done** 🎉. Ping @équipe-{n} \
             if the *{}* numbers look wrong.\n\n",
            word(n)
        ),
    }
}

fn word(n: usize) -> &'static str {
    const WORDS: &[&str] = &[
        "ingest", "decorate", "reveal", "diff", "layout", "mirror", "rope", "patch", "widget",
        "gutter", "conceal", "anchor", "cursor", "glyph",
    ];
    WORDS[n % WORDS.len()]
}

/// Ordinary prose with no markup in it at all: same byte count, almost no decorations.
///
/// This is the control. DESIGN §2.2's claim is about *parsing*, and comparing this
/// against [`document`] separates the cost of walking N bytes of markdown from the cost
/// of building a decoration for every node found in it. Without the control there is no
/// way to tell whether a slow reparse means a slow parser or an expensive per-node
/// build — and the fix is completely different in the two cases.
fn prose(target_bytes: usize) -> String {
    let mut s = String::with_capacity(target_bytes + 512);
    let mut n = 0usize;
    while s.len() < target_bytes {
        for i in 0..40 {
            s.push_str(word(n + i));
            s.push(' ');
        }
        s.push_str("\n\n");
        n += 7;
    }
    s
}

fn document(target_bytes: usize) -> String {
    let mut s = String::with_capacity(target_bytes + 512);
    s.push_str("# Benchmark corpus\n\n");
    let mut n = 0usize;
    while s.len() < target_bytes {
        s.push_str(&block(n));
        n += 1;
    }
    s
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

struct Stat {
    min: Duration,
    median: Duration,
    mean: Duration,
}

impl Stat {
    fn of(mut samples: Vec<Duration>) -> Stat {
        samples.sort_unstable();
        let sum: Duration = samples.iter().sum();
        Stat {
            min: samples[0],
            median: samples[samples.len() / 2],
            mean: sum / samples.len() as u32,
        }
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// `round` performs one repetition and returns only the part that should be measured.
/// Several of these benchmarks have to restore state they mutate — a fresh mirror, an
/// emptied decoration set — and that restore must not land in the sample, so the
/// closure decides for itself what the stopwatch covers via [`timed`].
fn bench<F: FnMut() -> Duration>(iters: usize, mut round: F) -> Stat {
    // One untimed repetition so first-touch page faults and a cold branch predictor are
    // not attributed to the measurement.
    round();
    let mut samples = Vec::with_capacity(iters);
    for _ in 0..iters {
        samples.push(round());
    }
    Stat::of(samples)
}

/// Times `f`, keeping its result alive so the optimiser cannot delete the work.
fn timed<T>(f: impl FnOnce() -> T) -> Duration {
    let t = Instant::now();
    black_box(f());
    t.elapsed()
}

/// Enough repetitions to get a stable median without the 5 MB case taking a minute.
fn iters_for(bytes: usize) -> usize {
    match bytes {
        0..=200_000 => 200,
        200_001..=600_000 => 60,
        600_001..=2_000_000 => 30,
        _ => 10,
    }
}

// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--dump") {
        let dir = args.get(i + 1).map(String::as_str).unwrap_or("target/bench-corpus");
        dump(dir);
        return;
    }

    println!("mde-core keystroke benchmark  (profile: {})", profile());
    println!("all times in milliseconds; n = iterations, med = median\n");

    let check = args.iter().any(|arg| arg == "--check");
    for &(label, bytes) in SIZES {
        let result = run(label, bytes);
        if check {
            for (metric, value) in [
                ("EDIT", result.edit_ms),
                ("SELECTION", result.selection_ms),
                ("LAYER", result.layer_ms),
            ] {
                let key = format!(
                    "MDE_CORE_{}_{}_BUDGET_MS",
                    label.replace(' ', ""),
                    metric
                );
                if let Ok(raw) = std::env::var(&key) {
                    let budget: f64 =
                        raw.parse().unwrap_or_else(|_| panic!("invalid {key}={raw}"));
                    assert!(
                        value <= budget,
                        "{label} {} median {value:.3} ms exceeds {budget:.3} ms budget",
                        metric.to_ascii_lowercase()
                    );
                    println!(
                        "   {} budget: {value:.3} <= {budget:.3} ms",
                        metric.to_ascii_lowercase()
                    );
                }
            }
            println!();
        }
    }

    println!("\nBudget: DESIGN §2.2 allows 4 ms for parse + decorate + diff before the");
    println!("core is supposed to fall back to viewport-only decoration.");
}

fn profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug — NOT representative, rerun with --release"
    } else {
        "release"
    }
}

fn dump(dir: &str) {
    std::fs::create_dir_all(dir).expect("create corpus dir");
    for &(label, bytes) in SIZES {
        let doc = document(bytes);
        let name = format!("{dir}/{}.md", label.replace(' ', ""));
        std::fs::write(&name, &doc).expect("write corpus");
        println!("{name}  {} bytes", doc.len());
    }
    // The renderer benchmarks need the same extension rules or their decoration counts
    // will not line up with the core's.
    std::fs::write(format!("{dir}/manifest.toml"), MANIFEST).expect("write manifest");
    println!("{dir}/manifest.toml");
}

struct RunResult {
    edit_ms: f64,
    selection_ms: f64,
    layer_ms: f64,
}

fn run(label: &str, bytes: usize) -> RunResult {
    let doc = document(bytes);
    let n = iters_for(doc.len());
    let reg = || Registry::from_toml(MANIFEST).expect("manifest parses");

    let mut engine = Engine::new(reg());
    engine.reset(&doc);
    let decorations = engine.decorations().len();
    // A caret parked mid-document, as it would be while typing. Reveal resolution only
    // does work when there *is* a selection, so measuring unfocused would be cheating.
    let mid_u16 = doc[..doc.len() / 2].encode_utf16().count() as u32;
    engine.set_selection(Some(Selection::caret(mid_u16)));

    println!("== {label}  ({} bytes, {decorations} decorations, n={n})", doc.len());

    // -- cold parse -----------------------------------------------------------------
    // `reset("")` before each timed call so the diff really is "everything added",
    // which is what a document open costs. Resetting onto an identical prior set would
    // measure a no-op diff instead.
    let mut e = Engine::new(reg());
    let cold = bench(n, || {
        e.reset("");
        timed(|| e.reset(&doc))
    });

    // -- keystroke ------------------------------------------------------------------
    // A single character inserted mid-document: local reparse + decoration splice + diff.
    // Each iteration grows the document by one byte, which at these iteration counts is
    // under 2% and well inside the noise.
    let mut e = Engine::new(reg());
    e.reset(&doc);
    e.set_selection(Some(Selection::caret(mid_u16)));
    let mut at = mid_u16;
    let mut len = doc.encode_utf16().count() as u32;
    let key = bench(n, || {
        len += 1;
        at += 1;
        let edit = [Edit { start: at, end: at, text: "x".into() }];
        timed(|| e.edit(&edit, Some(len), 1000))
    });

    // What one keystroke asks the renderer to do. This is the number the renderer's
    // dirty-range rule (DESIGN §7, "moves must not repaint") has to survive.
    let mut e = Engine::new(reg());
    e.reset(&doc);
    e.set_selection(Some(Selection::caret(mid_u16)));
    let before = e.decorations().to_vec();
    let patch = e
        .edit(&[Edit { start: mid_u16, end: mid_u16, text: "x".into() }], None, 1000)
        .expect("in-bounds edit");
    let after = e.decorations().to_vec();
    let (n_add, n_rem, n_shift, n_mov) = (
        patch.added.len(), patch.removed.len(), patch.shifted.len(), patch.moved.len()
    );

    // -- structural fallback scan ----------------------------------------------------
    // Ordinary edits shift the trusted boundary index. Newlines, fences, directives,
    // and reference definitions take this conservative full-document fallback.
    let text_for_scan = doc.clone();
    let registry_for_scan = reg();
    let scan = bench(n, || {
        timed(|| {
            std::hint::black_box(mde_core::region::Regions::scan(
                &text_for_scan,
                &registry_for_scan,
            ))
        })
    });

    // -- selection ------------------------------------------------------------------
    // No reparse: query the reveal interval index and patch only the decoration kinds
    // whose reveal state changed. Alternating between a caret inside a node and one
    // outside keeps the patch non-empty, as a real caret move is.
    let mut e = Engine::new(reg());
    e.reset(&doc);
    let mut flip = false;
    let sel = bench(n, || {
        flip = !flip;
        let caret = Selection::caret(if flip { mid_u16 } else { mid_u16 + 40 });
        timed(|| e.set_selection(Some(caret)))
    });

    // -- plugin layer ---------------------------------------------------------------
    // Move one cursor-driven decoration without touching the parsed prefix. This is a
    // common plugin operation (focus, diagnostics, collaborators) and must scale with
    // the plugin output, not with every markdown decoration already in the document.
    let mut e = Engine::new(reg());
    e.reset(&doc);
    let role = e.intern_role("benchmark-plugin");
    let mut layer_at = mid_u16;
    const LAYER_BATCH: u32 = 1_000;
    let layer = bench(n, || {
        timed(|| {
            for _ in 0..LAYER_BATCH {
                layer_at = if layer_at == mid_u16 { mid_u16 + 40 } else { mid_u16 };
                e.set_layer(
                    "benchmark-plugin",
                    &[LayerSpan {
                        start: layer_at,
                        end: layer_at + 5,
                        role,
                        kind: Kind::Style,
                        depth: 0,
                    }],
                );
            }
        }) / LAYER_BATCH
    });

    // -- breakdown ------------------------------------------------------------------
    // Independent diagnostics for the expensive operations surrounding `Engine::edit`.
    // These deliberately are not summed: production edits use a regional build and an
    // incremental payload update, while the isolated probes below exercise full builds
    // to make parser and registry costs comparable across releases.
    let registry = reg();
    let base = Text::new(&doc);
    let mut scratch = base.clone();
    let one = [Edit { start: mid_u16, end: mid_u16, text: "x".into() }];
    let apply = bench(n, || {
        scratch = base.clone();
        timed(|| scratch.apply(&one, None))
    });

    let build = bench(n, || timed(|| decorate::build(&base, &registry)));

    let built: Vec<Built> = decorate::build(&base, &registry);
    let payloads = bench(n, || {
        timed(|| {
            built
                .iter()
                .filter_map(|b| b.payload.as_ref().map(|p| (b.key, p.clone())))
                .collect::<HashMap<_, _>>()
        })
    });

    let dif = bench(n, || timed(|| diff::diff(&before, &after)));

    // How much of `build` the extension registry is responsible for. Each variant still
    // walks the whole parser; the gaps price the manifest's rules — the inline pattern
    // scan, and the directive line scan plus the pass that masks decorations falling
    // inside a directive block.
    //
    // The decoration counts differ between variants and are printed for that reason: a
    // registry without the `chart` rule sees `:::chart` as an ordinary paragraph, so it
    // is not purely "the same work minus one step". The counts keep that visible.
    let plain = Registry::empty();
    let build_plain = bench(n, || timed(|| decorate::build(&base, &plain)));
    let manifest_no_directive = MANIFEST.replace(MANIFEST_DIRECTIVE, "");
    assert_ne!(manifest_no_directive, MANIFEST, "the directive rule must actually be removed");
    let no_directive = Registry::from_toml(&manifest_no_directive)
        .expect("manifest without the directive rule still parses");
    let build_no_directive = bench(n, || timed(|| decorate::build(&base, &no_directive)));
    let counts = (
        decorate::build(&base, &plain).len(),
        decorate::build(&base, &no_directive).len(),
        built.len(),
    );

    // The control: same byte count, no markup, so `build` produces nothing and what is
    // left is the cost of *reaching* the end of the document. Measured twice, because
    // the two registries answer different questions — with built-ins only it is the
    // parser walk on its own, which is the number DESIGN §2.2's "roughly 0.1 ms" is a
    // claim about; with the full manifest it also includes the inline rule scan, which
    // runs over every literal text run whether or not anything matches.
    let flat = Text::new(prose(bytes));
    let flat_count = decorate::build(&flat, &registry).len();
    let walk = bench(n, || timed(|| decorate::build(&flat, &plain)));
    let build_flat = bench(n, || timed(|| decorate::build(&flat, &registry)));

    // The diagnostics report minima, not medians. Each operation is measured in a
    // separate loop; its minimum is the closest it gets to its own isolated cost.

    row("reset (cold parse)", &cold);
    row("edit (one keystroke)", &key);
    row("set_selection", &sel);
    precise_row("set_layer (one span)", &layer);
    println!(
        "   patch for that keystroke: {n_add} added, {n_rem} removed, \
         {n_shift} suffix shifts, {n_mov} explicit moves"
    );
    println!("   independent diagnostics (min):");
    sub("mirror apply + reindex", apply.min, key.min);
    sub("structural fallback scan", scan.min, key.min);
    sub("decorate::build", build.min, key.min);
    sub("full payload map collect", payloads.min, key.min);
    sub("selection interval patch", sel.min, key.min);
    sub("  of which diff::diff", dif.min, key.min);
    println!("   decorate::build by registry (min, share of full):");
    sub(&format!("built-ins only ({})", counts.0), build_plain.min, build.min);
    sub(&format!("+ inline rules ({})", counts.1), build_no_directive.min, build.min);
    sub(&format!("+ directive rule ({})", counts.2), build.min, build.min);
    println!(
        "   control: {} bytes of plain prose -> {flat_count} decorations",
        flat.as_str().len()
    );
    println!("      {:<26} {:>9.3}", "parser walk only", ms(walk.min));
    println!("      {:<26} {:>9.3}", "+ inline rule scan", ms(build_flat.min));
    println!(
        "      {:<26} {:>9.0} ns",
        "per decoration, this corpus",
        (ms(build.min) - ms(build_flat.min)) * 1e6 / decorations.max(1) as f64
    );
    println!();
    RunResult {
        edit_ms: ms(key.median),
        selection_ms: ms(sel.median),
        layer_ms: ms(layer.median),
    }
}

/// The `:::chart` rule, split out so the benchmark can build a registry without it and
/// price the directive masking pass on its own.
const MANIFEST_DIRECTIVE: &str = r#"[[block]]
name   = "chart"
syntax = { kind = "directive", marker = ":::", name = "chart" }
render = "block_widget"
reveal = "caret_in_block"
"#;

fn row(label: &str, s: &Stat) {
    println!(
        "   {label:<22} min {:>9.3}  med {:>9.3}  mean {:>9.3}",
        ms(s.min),
        ms(s.median),
        ms(s.mean)
    );
}

fn precise_row(label: &str, s: &Stat) {
    println!(
        "   {label:<22} min {:>9.6}  med {:>9.6}  mean {:>9.6}",
        ms(s.min),
        ms(s.median),
        ms(s.mean)
    );
}

fn sub(label: &str, part: Duration, whole: Duration) {
    let pct = if whole.is_zero() { 0.0 } else { ms(part) / ms(whole) * 100.0 };
    println!("      {label:<26} {:>9.3}  ({pct:>5.1}%)", ms(part));
}
