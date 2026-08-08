//! Browsable revision history (DESIGN §9).
//!
//! Undo and redo are the two-button view of a timeline. These tests pin the rest of it:
//! that the timeline can be listed, that undone revisions stay visible, and — the one
//! that matters — that landing on a point by jumping produces byte-identically the same
//! document as walking there one step at a time.

use mde_core::{Edit, Engine, Registry, RevisionKind};

fn engine() -> Engine {
    let mut e = Engine::new(Registry::empty());
    e.reset("start\n");
    e
}

/// Each call is far enough apart in time to defeat undo coalescing, so the revisions
/// stay separate and countable.
fn type_at(e: &mut Engine, at: u32, text: &str, step: u64) {
    e.edit(&[Edit { start: at, end: at, text: text.into() }], None, step * 10_000).unwrap();
}

#[test]
fn revisions_are_listed_oldest_first() {
    let mut e = engine();
    type_at(&mut e, 5, " one", 1);
    type_at(&mut e, 9, " two", 2);
    type_at(&mut e, 13, " three", 3);

    let revs = e.revisions();
    assert_eq!(revs.len(), 3);
    assert_eq!(revs.iter().map(|r| r.index).collect::<Vec<_>>(), vec![0, 1, 2]);
    assert!(revs[0].at_ms < revs[1].at_ms, "timestamps should increase");
    assert_eq!(e.history_position(), 3, "all three are applied");
}

#[test]
fn a_revision_reports_what_it_did() {
    let mut e = engine();
    type_at(&mut e, 5, " added", 1);
    e.edit(&[Edit { start: 0, end: 5, text: "".into() }], None, 20_000).unwrap();
    e.edit(&[Edit { start: 0, end: 3, text: "XY".into() }], None, 30_000).unwrap();

    let revs = e.revisions();
    assert_eq!(revs[0].kind, RevisionKind::Insert);
    assert_eq!(revs[0].inserted, 6);
    assert_eq!(revs[0].removed, 0);

    assert_eq!(revs[1].kind, RevisionKind::Delete);
    assert_eq!(revs[1].removed, 5);

    assert_eq!(revs[2].kind, RevisionKind::Replace, "both sides non-empty");
    assert_eq!((revs[2].inserted, revs[2].removed), (2, 3));
}

#[test]
fn undone_revisions_stay_in_the_list() {
    let mut e = engine();
    type_at(&mut e, 5, " one", 1);
    type_at(&mut e, 9, " two", 2);
    e.undo().unwrap();

    // The whole point of a browsable history: stepping back must not erase the branch
    // you stepped back from, or there is nothing to step forward *to* in the panel.
    assert_eq!(e.revisions().len(), 2, "the undone revision is still listed");
    assert_eq!(e.history_position(), 1, "but only one is applied");
}

#[test]
fn jumping_back_lands_where_stepping_back_would() {
    let mut walked = engine();
    let mut jumped = engine();
    for (i, word) in [" one", " two", " three", " four"].iter().enumerate() {
        let at = walked.text().encode_utf16().count() as u32;
        type_at(&mut walked, at, word, i as u64 + 1);
        let at = jumped.text().encode_utf16().count() as u32;
        type_at(&mut jumped, at, word, i as u64 + 1);
    }

    // Walk back three steps.
    for _ in 0..3 {
        walked.undo().unwrap();
    }
    // Land on the same point in one move.
    jumped.jump_to(1).unwrap();

    assert_eq!(jumped.text(), walked.text());
    assert_eq!(jumped.history_position(), walked.history_position());
    assert_eq!(jumped.decorations(), walked.decorations(), "and the same decorations");
}

#[test]
fn jumping_forward_lands_where_stepping_forward_would() {
    let mut e = engine();
    for (i, word) in [" one", " two", " three"].iter().enumerate() {
        let at = e.text().encode_utf16().count() as u32;
        type_at(&mut e, at, word, i as u64 + 1);
    }
    let newest = e.text().to_string();

    e.jump_to(0).unwrap();
    assert_eq!(e.text(), "start\n");

    e.jump_to(3).unwrap();
    assert_eq!(e.text(), newest, "jumping forward restores the newest state");
}

#[test]
fn the_returned_edit_reconstructs_the_target_text() {
    let mut e = engine();
    for (i, word) in [" alpha", " beta", " gamma"].iter().enumerate() {
        let at = e.text().encode_utf16().count() as u32;
        type_at(&mut e, at, word, i as u64 + 1);
    }
    let before = e.text().to_string();

    let (rewind, _) = e.jump_to(1).unwrap();

    // A host applies the rewind to its own buffer, so the edit has to be enough on its
    // own — this is the contract that keeps the mirror and the platform in step.
    assert_eq!(rewind.edits.len(), 1, "a jump is one splice, however far it goes");
    let edit = &rewind.edits[0];
    let units: Vec<u16> = before.encode_utf16().collect();
    let rebuilt: String = String::from_utf16_lossy(&units[..edit.start as usize])
        + &edit.text
        + &String::from_utf16_lossy(&units[edit.end as usize..]);
    assert_eq!(rebuilt, e.text());
}

#[test]
fn jumping_to_the_current_position_is_a_no_op() {
    let mut e = engine();
    type_at(&mut e, 5, " one", 1);
    assert!(e.jump_to(1).is_none(), "already there");
}

#[test]
fn jumping_out_of_range_is_refused_rather_than_clamped() {
    let mut e = engine();
    type_at(&mut e, 5, " one", 1);
    assert!(e.jump_to(99).is_none());
    // And the document is untouched by the refusal.
    assert_eq!(e.text(), "start one\n");
}

#[test]
fn a_jump_then_an_edit_discards_the_abandoned_branch() {
    let mut e = engine();
    for (i, word) in [" one", " two", " three"].iter().enumerate() {
        let at = e.text().encode_utf16().count() as u32;
        type_at(&mut e, at, word, i as u64 + 1);
    }
    e.jump_to(1).unwrap();
    assert_eq!(e.revisions().len(), 3, "the abandoned branch is still browsable");

    // Editing from a rewound point forks: the future that was there is gone, exactly as
    // it is for redo after an edit.
    let at = e.text().encode_utf16().count() as u32;
    type_at(&mut e, at, " different", 9);
    assert_eq!(e.revisions().len(), 2, "the old branch is discarded by the new edit");
    assert_eq!(e.text(), "start\n one different");
}

#[test]
fn jumping_round_trips_over_astral_characters() {
    let mut e = Engine::new(Registry::empty());
    e.reset("a\n");
    // Emoji are surrogate pairs in UTF-16, and the jump diff must never split one.
    e.edit(&[Edit { start: 1, end: 1, text: "😀🎉".into() }], None, 10_000).unwrap();
    e.edit(&[Edit { start: 5, end: 5, text: "😀".into() }], None, 20_000).unwrap();
    let newest = e.text().to_string();

    e.jump_to(0).unwrap();
    assert_eq!(e.text(), "a\n");
    e.jump_to(2).unwrap();
    assert_eq!(e.text(), newest);
}

#[test]
fn a_reset_clears_the_timeline() {
    let mut e = engine();
    type_at(&mut e, 5, " one", 1);
    e.reset("something else\n");
    assert!(e.revisions().is_empty());
    assert_eq!(e.history_position(), 0);
}

#[test]
fn walking_the_whole_timeline_in_both_directions_is_consistent() {
    let mut e = engine();
    let mut states = vec![e.text().to_string()];
    for (i, word) in [" one", " two", " three", " four", " five"].iter().enumerate() {
        let at = e.text().encode_utf16().count() as u32;
        type_at(&mut e, at, word, i as u64 + 1);
        states.push(e.text().to_string());
    }

    // Every point in the timeline, reached from wherever the previous assertion left us
    // — backwards, forwards and in jumps of more than one.
    for target in [0usize, 5, 2, 4, 1, 3, 0, 5] {
        if target != e.history_position() {
            e.jump_to(target).unwrap();
        }
        assert_eq!(e.text(), states[target], "landing on {target}");
        assert_eq!(e.history_position(), target);
    }
}
