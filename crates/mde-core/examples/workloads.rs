//! Adversarial and long-session performance workloads for the shared core.
//!
//! The ordinary benchmark uses a representative mixed document. This companion report
//! deliberately exercises shapes that can defeat regional parsing or stable identity:
//! repeated byte-identical nodes, one giant block, an unterminated fence, Unicode-heavy
//! lines, edits at each document position, and a sustained typing session.

use mde_core::{Edit, Engine, Registry, Selection};
use std::hint::black_box;
use std::time::Instant;

const MANIFEST: &str = r#"
[[block]]
name   = "callout"
syntax = { kind = "fence", info = "callout" }
render = "block_widget"
reveal = "caret_in_block"

[[inline]]
name   = "mention"
syntax = { kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }
render = "inline_widget"
reveal = "caret_in_node"
"#;

#[derive(Clone, Copy)]
struct Sample {
    ms: f64,
    added: usize,
    removed: usize,
    moved: usize,
    shifted: usize,
}

fn registry() -> Registry {
    Registry::from_toml(MANIFEST).expect("benchmark manifest parses")
}

fn mixed_document(bytes: usize) -> String {
    let mut out = String::with_capacity(bytes + 256);
    let mut n = 0;
    while out.len() < bytes {
        out.push_str(&format!(
            "## Section {n}\n\nParagraph {n} has **strong text**, *emphasis*, `code`, \
             [a link](https://example.dev/{n}), and @owner-{n}.\n\n- [ ] task {n}\n\n"
        ));
        n += 1;
    }
    out
}

fn repeated_document(bytes: usize) -> String {
    "A **repeated node** with @same and [the same link](same.png).\n\n".repeat(bytes / 64 + 1)
}

fn giant_paragraph(bytes: usize) -> String {
    "word **strong** @same résumé 日本語 🎉 ".repeat(bytes / 48 + 1)
}

fn unterminated_fence(bytes: usize) -> String {
    let mut out = String::from("```text\n");
    out.push_str(
        &"code that never closes and contains **literal syntax**\n".repeat(bytes / 55 + 1),
    );
    out
}

fn unicode_document(bytes: usize) -> String {
    "## 段階 🎉\n\nLe résumé **重要** — Καλημέρα — مرحبا — @owner.\n\n".repeat(bytes / 80 + 1)
}

fn timed_edit(engine: &mut Engine, at: u32, expected: u32) -> Sample {
    let started = Instant::now();
    let patch = black_box(
        engine
            .edit(
                &[Edit {
                    start: at,
                    end: at,
                    text: "x".into(),
                }],
                Some(expected),
                1_000,
            )
            .expect("workload edit is valid"),
    );
    Sample {
        ms: started.elapsed().as_secs_f64() * 1_000.0,
        added: patch.added.len(),
        removed: patch.removed.len(),
        moved: patch.moved.len(),
        shifted: patch.shifted.len(),
    }
}

fn percentile(samples: &[Sample], quantile: f64) -> f64 {
    let mut values: Vec<_> = samples.iter().map(|sample| sample.ms).collect();
    values.sort_by(f64::total_cmp);
    let index = ((values.len() - 1) as f64 * quantile).ceil() as usize;
    values[index]
}

fn report(label: &str, samples: &[Sample]) {
    let max = samples.iter().max_by(|a, b| a.ms.total_cmp(&b.ms)).unwrap();
    println!(
        "{label:<30} p50 {:>8.3}  p95 {:>8.3}  max {:>8.3} ms  patch max +{} -{} ~{} shift{}",
        percentile(samples, 0.50),
        percentile(samples, 0.95),
        max.ms,
        samples.iter().map(|s| s.added).max().unwrap_or(0),
        samples.iter().map(|s| s.removed).max().unwrap_or(0),
        samples.iter().map(|s| s.moved).max().unwrap_or(0),
        samples.iter().map(|s| s.shifted).max().unwrap_or(0),
    );
}

fn position_workload(label: &str, document: &str, fraction: f64, iterations: usize) {
    let mut engine = Engine::new(registry());
    engine.reset(document);
    let mut length = document.encode_utf16().count() as u32;
    let start = (f64::from(length) * fraction) as u32;
    engine.set_selection(Some(Selection::caret(start)));
    let mut samples = Vec::with_capacity(iterations);
    for at in (start..).take(iterations) {
        length += 1;
        samples.push(timed_edit(&mut engine, at, length));
    }
    report(label, &samples);
}

fn one_shot(label: &str, document: &str, iterations: usize) -> f64 {
    let length = document.encode_utf16().count() as u32;
    let at = length / 2;
    let samples: Vec<_> = (0..iterations)
        .map(|_| {
            let mut engine = Engine::new(registry());
            engine.reset(document);
            engine.set_selection(Some(Selection::caret(at)));
            timed_edit(&mut engine, at, length + 1)
        })
        .collect();
    report(label, &samples);
    percentile(&samples, 0.50)
}

fn enforce_budget(label: &str, measured: f64, variable: &str) {
    let budget: f64 = std::env::var(variable)
        .unwrap_or_else(|_| panic!("{variable} is required with --check"))
        .parse()
        .unwrap_or_else(|_| panic!("{variable} must be a number"));
    println!("   {label} budget: {measured:.3} <= {budget:.3} ms");
    assert!(measured <= budget, "{label} exceeded {budget:.3} ms: {measured:.3} ms");
}

fn main() {
    println!("mde-core adversarial workloads (release profile expected)\n");
    let arguments: Vec<_> = std::env::args().collect();
    let check = arguments.iter().any(|argument| argument == "--check");
    if arguments.iter().any(|argument| argument == "--giant-only") {
        let giant = one_shot("32KB giant paragraph", &giant_paragraph(32 * 1024), 10);
        if check {
            enforce_budget(
                "32KB giant paragraph",
                giant,
                "MDE_CORE_GIANT_PARAGRAPH_BUDGET_MS",
            );
        }
        return;
    }
    let one_mb = mixed_document(1024 * 1024);
    position_workload("1MB edit near start", &one_mb, 0.01, 20);
    position_workload("1MB edit in middle", &one_mb, 0.50, 20);
    position_workload("1MB edit near end", &one_mb, 0.99, 20);

    one_shot(
        "1MB repeated identities",
        &repeated_document(1024 * 1024),
        7,
    );
    // These intentionally disable or greatly widen regional parsing. Keep them large
    // enough to expose scaling without making a routine performance run take minutes.
    let giant = one_shot("32KB giant paragraph", &giant_paragraph(32 * 1024), 3);
    if check {
        enforce_budget(
            "32KB giant paragraph",
            giant,
            "MDE_CORE_GIANT_PARAGRAPH_BUDGET_MS",
        );
    }
    one_shot(
        "256KB unterminated fence",
        &unterminated_fence(256 * 1024),
        3,
    );
    one_shot("256KB Unicode-heavy", &unicode_document(256 * 1024), 3);

    let endurance = mixed_document(100 * 1024);
    position_workload("100KB sustained 2000 edits", &endurance, 0.50, 2_000);
}
