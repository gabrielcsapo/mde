//! Undo/redo owned by the core.
//!
//! The platform's own undo manager sees keystrokes, not structure — undoing a
//! bold-toggle would come back as two unrelated character deletions. Owning the log
//! here means grouping is decided once, next to the code that knows what a markdown
//! edit *was*, and it is the same on all three platforms.
//!
//! The flow inverts on undo. Normally edits travel platform -> core; an undo travels
//! core -> platform, which must apply the returned edits to its own buffer **without**
//! reporting them back (that would record the undo as a new revision).

use crate::text::Edit;
use crate::Selection;
use std::collections::VecDeque;

/// Consecutive keystrokes inside this window merge into one undo step.
pub const COALESCE_WINDOW_MS: u64 = 700;
const DEFAULT_LIMIT: usize = 500;

#[derive(Debug, Clone)]
pub struct Revision {
    /// Applied to the post-edit document to get back to `sel_before`'s document.
    pub undo: Vec<Edit>,
    /// Applied to the pre-edit document to redo. Offsets are pre-edit coordinates.
    pub redo: Vec<Edit>,
    pub sel_before: Option<Selection>,
    pub sel_after: Option<Selection>,
    at_ms: u64,
    /// Still able to absorb an adjacent keystroke.
    open: bool,
}

/// What kind of gesture produced a revision, for a history panel to label it.
///
/// Coarse on purpose. The core knows what characters moved, not what the person meant,
/// and a label that guesses too confidently ("renamed a heading") is worse than one that
/// states what happened.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionKind {
    Insert = 0,
    Delete = 1,
    /// Both sides non-empty — a replacement, a paste over a selection, a command.
    Replace = 2,
}

/// One entry in a browsable history (DESIGN §9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevisionInfo {
    /// Position in the timeline. Jumping to `index` means "the document as it was
    /// immediately after this revision was applied".
    pub index: u32,
    pub at_ms: u64,
    /// UTF-16 code units added and removed by this revision.
    pub inserted: u32,
    pub removed: u32,
    pub kind: RevisionKind,
    /// Where in the document it happened, in the coordinates of the document *after*
    /// the revision — enough for a panel to scroll to it.
    pub at: u32,
}

impl Revision {
    fn info(&self, index: u32) -> RevisionInfo {
        // Measured from the redo side, which describes the change in the direction a
        // reader thinks about it: what this revision *did*.
        let inserted: u32 = self.redo.iter().map(|e| e.text.chars().map(char::len_utf16).sum::<usize>() as u32).sum();
        let removed: u32 = self.redo.iter().map(|e| e.end.saturating_sub(e.start)).sum();
        let kind = match (inserted > 0, removed > 0) {
            (true, false) => RevisionKind::Insert,
            (false, true) => RevisionKind::Delete,
            _ => RevisionKind::Replace,
        };
        RevisionInfo {
            index,
            at_ms: self.at_ms,
            inserted,
            removed,
            kind,
            at: self.redo.first().map_or(0, |e| e.start),
        }
    }
}

/// What the platform must do to bring its buffer in line after undo/redo.
#[derive(Debug, Clone)]
pub struct Rewind {
    pub edits: Vec<Edit>,
    pub selection: Option<Selection>,
}

#[derive(Debug, Default)]
pub struct History {
    /// A deque, not a `Vec`: once the history is full every new revision evicts the
    /// oldest, and `Vec::remove(0)` shifts all 500 behind it on every keystroke.
    /// `pop_front` is O(1), so the limit costs nothing to raise.
    past: VecDeque<Revision>,
    /// A plain `Vec` is right here — the redo branch is only ever pushed and popped at
    /// the end, and it is discarded wholesale by the next edit.
    future: Vec<Revision>,
    limit: usize,
}

fn len16(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn is_pure_insert(e: &Edit) -> bool {
    e.start == e.end && !e.text.is_empty()
}

fn is_pure_delete(e: &Edit) -> bool {
    e.text.is_empty() && e.end > e.start
}

impl History {
    pub fn new() -> Self {
        History { past: VecDeque::new(), future: Vec::new(), limit: DEFAULT_LIMIT }
    }

    pub fn clear(&mut self) {
        self.past.clear();
        self.future.clear();
    }

    pub fn can_undo(&self) -> bool {
        !self.past.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }

    pub fn depth(&self) -> (usize, usize) {
        (self.past.len(), self.future.len())
    }

    /// How many revisions have been applied — the caret's position in the timeline.
    ///
    /// `0` is the document as it was before anything was recorded. `len()` is the newest
    /// state. Undo moves this down, redo moves it up.
    pub fn position(&self) -> usize {
        self.past.len()
    }

    /// Every revision, oldest first, across both the applied and the undone side.
    ///
    /// This is what makes the history *browsable* rather than merely reversible: undone
    /// revisions are still listed, because a person looking at history wants to see the
    /// branch they stepped back from, not have it vanish.
    pub fn revisions(&self) -> Vec<RevisionInfo> {
        let mut out = Vec::with_capacity(self.past.len() + self.future.len());
        for (i, r) in self.past.iter().enumerate() {
            out.push(r.info(i as u32));
        }
        // `future` is a stack: the most recently undone revision is on top, so it is the
        // *earliest* of the undone ones in timeline order.
        for (i, r) in self.future.iter().rev().enumerate() {
            out.push(r.info((self.past.len() + i) as u32));
        }
        out
    }

    /// Force the next edit to start a new undo step. Call before a command that
    /// rewrites text (toggle bold, insert link) so it never merges with typing.
    pub fn close_group(&mut self) {
        if let Some(last) = self.past.back_mut() {
            last.open = false;
        }
    }

    /// Record an applied edit batch. `inverse` comes from `Text::apply`.
    pub fn record(
        &mut self,
        redo: &[Edit],
        inverse: Vec<Edit>,
        sel_before: Option<Selection>,
        sel_after: Option<Selection>,
        now_ms: u64,
    ) {
        // Any new edit invalidates the redo branch.
        self.future.clear();

        if self.try_coalesce(redo, &inverse, sel_after, now_ms) {
            return;
        }
        self.past.push_back(Revision {
            undo: inverse,
            redo: redo.to_vec(),
            sel_before,
            sel_after,
            at_ms: now_ms,
            open: true,
        });
        if self.past.len() > self.limit {
            self.past.pop_front();
        }
    }

    /// Merge a keystroke into the open revision when it continues the same gesture.
    ///
    /// Only two gestures coalesce, because only two are unambiguous: a forward typing
    /// run and a backspace run. A newline closes the run — a paragraph break is where
    /// a person expects undo to stop.
    fn try_coalesce(
        &mut self,
        redo: &[Edit],
        inverse: &[Edit],
        sel_after: Option<Selection>,
        now_ms: u64,
    ) -> bool {
        let Some(prev) = self.past.back_mut() else { return false };
        if !prev.open
            || now_ms.saturating_sub(prev.at_ms) > COALESCE_WINDOW_MS
            || prev.redo.len() != 1
            || redo.len() != 1
            || inverse.len() != 1
            || prev.undo.len() != 1
        {
            return false;
        }
        let (p, n) = (&prev.redo[0], &redo[0]);

        if is_pure_insert(p) && is_pure_insert(n) {
            // Typing forward: the new character lands exactly at the run's end.
            if p.text.contains('\n')
                || n.text.contains('\n')
                || n.start != p.start + len16(&p.text)
            {
                return false;
            }
            prev.redo[0].text.push_str(&n.text);
            prev.undo[0].end = inverse[0].end;
        } else if is_pure_delete(p) && is_pure_delete(n) {
            // Backspace run: each deletion ends where the previous one began.
            if n.end != p.start {
                return false;
            }
            let restored = format!("{}{}", inverse[0].text, prev.undo[0].text);
            if restored.contains('\n') {
                return false;
            }
            prev.redo[0].start = n.start;
            prev.undo[0] = Edit { start: inverse[0].start, end: inverse[0].start, text: restored };
        } else {
            return false;
        }

        prev.sel_after = sel_after;
        prev.at_ms = now_ms;
        true
    }

    /// Pop an undo step. The caller applies `Rewind::edits` to the buffer.
    pub fn undo(&mut self) -> Option<Rewind> {
        let rev = self.past.pop_back()?;
        let rewind = Rewind { edits: rev.undo.clone(), selection: rev.sel_before };
        self.future.push(rev);
        Some(rewind)
    }

    pub fn redo(&mut self) -> Option<Rewind> {
        let mut rev = self.future.pop()?;
        let rewind = Rewind { edits: rev.redo.clone(), selection: rev.sel_after };
        // A redone revision is closed: typing after redo must not extend it.
        rev.open = false;
        self.past.push_back(rev);
        Some(rewind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::Text;

    /// Drives history the way `Engine` does, so the tests exercise the real contract.
    struct Harness {
        text: Text,
        history: History,
    }

    impl Harness {
        fn new(src: &str) -> Self {
            Harness { text: Text::new(src), history: History::new() }
        }

        fn edit(&mut self, start: u32, end: u32, text: &str, now_ms: u64) {
            let edits = vec![Edit { start, end, text: text.into() }];
            let inverse = self.text.apply(&edits, None).unwrap();
            let after = Some(Selection::caret(start + len16(text)));
            self.history.record(&edits, inverse, Some(Selection::caret(end)), after, now_ms);
        }

        fn type_str(&mut self, at: u32, s: &str, start_ms: u64) {
            let mut pos = at;
            for (i, ch) in s.chars().enumerate() {
                self.edit(pos, pos, &ch.to_string(), start_ms + i as u64 * 50);
                pos += ch.len_utf16() as u32;
            }
        }

        fn undo(&mut self) -> bool {
            match self.history.undo() {
                Some(r) => {
                    self.text.apply(&r.edits, None).unwrap();
                    true
                }
                None => false,
            }
        }

        fn redo(&mut self) -> bool {
            match self.history.redo() {
                Some(r) => {
                    self.text.apply(&r.edits, None).unwrap();
                    true
                }
                None => false,
            }
        }
    }

    #[test]
    fn a_typing_run_undoes_as_one_step() {
        let mut h = Harness::new("");
        h.type_str(0, "hello", 1000);
        assert_eq!(h.text.as_str(), "hello");
        assert_eq!(h.history.depth().0, 1, "five keystrokes should be one undo step");
        assert!(h.undo());
        assert_eq!(h.text.as_str(), "");
        assert!(!h.undo());
    }

    #[test]
    fn a_pause_starts_a_new_undo_step() {
        let mut h = Harness::new("");
        h.type_str(0, "abc", 1000);
        h.type_str(3, "def", 1000 + COALESCE_WINDOW_MS + 500);
        assert_eq!(h.text.as_str(), "abcdef");
        assert_eq!(h.history.depth().0, 2);
        h.undo();
        assert_eq!(h.text.as_str(), "abc");
        h.undo();
        assert_eq!(h.text.as_str(), "");
    }

    #[test]
    fn a_newline_closes_the_typing_run() {
        let mut h = Harness::new("");
        h.type_str(0, "ab\ncd", 1000);
        assert!(h.history.depth().0 >= 2, "a paragraph break must be an undo stop");
        h.undo();
        assert_eq!(h.text.as_str(), "ab\n");
    }

    #[test]
    fn typing_somewhere_else_starts_a_new_step() {
        let mut h = Harness::new("xxxx");
        h.type_str(4, "ab", 1000);
        h.type_str(0, "z", 1050); // same instant, non-adjacent position
        assert_eq!(h.text.as_str(), "zxxxxab");
        assert_eq!(h.history.depth().0, 2);
    }

    #[test]
    fn a_backspace_run_undoes_as_one_step() {
        let mut h = Harness::new("hello");
        for (i, at) in [(0u64, 5u32), (1, 4), (2, 3)] {
            h.edit(at - 1, at, "", 1000 + i * 50);
        }
        assert_eq!(h.text.as_str(), "he");
        assert_eq!(h.history.depth().0, 1);
        h.undo();
        assert_eq!(h.text.as_str(), "hello");
    }

    #[test]
    fn undo_then_redo_round_trips() {
        let mut h = Harness::new("start ");
        h.type_str(6, "one", 1000);
        h.type_str(9, " two", 5000);
        let full = h.text.as_str().to_string();

        h.undo();
        h.undo();
        assert_eq!(h.text.as_str(), "start ");
        assert!(h.redo());
        assert!(h.redo());
        assert_eq!(h.text.as_str(), full);
        assert!(!h.redo());
    }

    #[test]
    fn a_new_edit_discards_the_redo_branch() {
        let mut h = Harness::new("");
        h.type_str(0, "abc", 1000);
        h.undo();
        assert!(h.history.can_redo());
        h.type_str(0, "z", 9000);
        assert!(!h.history.can_redo(), "editing after undo must drop the redo branch");
    }

    #[test]
    fn typing_after_a_redo_does_not_extend_the_redone_step() {
        let mut h = Harness::new("");
        h.type_str(0, "ab", 1000);
        h.undo();
        h.redo();
        h.type_str(2, "c", 1100);
        assert_eq!(h.text.as_str(), "abc");
        assert_eq!(h.history.depth().0, 2);
        h.undo();
        assert_eq!(h.text.as_str(), "ab");
    }

    #[test]
    fn close_group_forces_a_boundary() {
        let mut h = Harness::new("");
        h.type_str(0, "ab", 1000);
        h.history.close_group();
        h.type_str(2, "cd", 1050);
        assert_eq!(h.history.depth().0, 2);
        h.undo();
        assert_eq!(h.text.as_str(), "ab");
    }

    #[test]
    fn undo_restores_the_selection_that_preceded_the_edit() {
        let mut h = Harness::new("hello");
        h.edit(5, 5, "!", 1000);
        let r = h.history.undo().unwrap();
        assert_eq!(r.selection, Some(Selection::caret(5)));
    }

    #[test]
    fn a_multi_range_edit_undoes_atomically() {
        let mut h = Harness::new("one two three");
        let edits = vec![
            Edit { start: 0, end: 3, text: "1".into() },
            Edit { start: 8, end: 13, text: "3".into() },
        ];
        let inverse = h.text.apply(&edits, None).unwrap();
        h.history.record(&edits, inverse, None, None, 1000);
        assert_eq!(h.text.as_str(), "1 two 3");
        h.undo();
        assert_eq!(h.text.as_str(), "one two three");
    }

    #[test]
    fn deep_history_stays_consistent_under_random_undo_redo() {
        let mut h = Harness::new("");
        let mut checkpoints = vec![String::new()];
        for i in 0..40u64 {
            h.type_str(len16(h.text.as_str()), &format!("w{i} "), i * 10_000);
            checkpoints.push(h.text.as_str().to_string());
        }
        for want in checkpoints.iter().rev().skip(1) {
            assert!(h.undo());
            assert_eq!(h.text.as_str(), want.as_str());
        }
        for want in checkpoints.iter().skip(1) {
            assert!(h.redo());
            assert_eq!(h.text.as_str(), want.as_str());
        }
    }
}
