//! The mirror buffer.
//!
//! The platform owns the authoritative text (`NSTextStorage`, the DOM). This is a
//! mirror kept in step by the same edit deltas the platform already applied. It is
//! deliberately a `String`: full reparse per keystroke (see DESIGN §2.2) means we
//! never need a rope's incremental splice, and a flat buffer keeps the UTF-16
//! boundary conversion simple. If profiling ever demands it, swap the internals —
//! the API below is what the rest of the core depends on.

/// Offsets in this struct's public API are **UTF-16 code units**, matching
/// `NSTextStorage` and JavaScript strings (DESIGN §3.2).
#[derive(Debug, Clone, Default)]
pub struct Text {
    s: String,
    lines: Vec<Line>,
    len_utf16: u32,
}

/// Where a line starts, in both encodings.
///
/// `ascii` is the reason this is a struct rather than a pair. Converting an offset
/// inside an ASCII line is `line.utf16 + (byte - line.byte)` — O(1) — while a line with
/// any non-ASCII needs a character scan. Real documents are overwhelmingly ASCII lines
/// even when they contain some emoji or CJK, and the conversion runs once per
/// decoration boundary on every keystroke, so the difference is the whole cost.
#[derive(Debug, Clone, Copy)]
struct Line {
    byte: u32,
    utf16: u32,
    ascii: bool,
}

/// A platform-applied edit, replacing `[start, end)` with `text`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub start: u32,
    pub end: u32,
    pub text: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EditError {
    /// The mirror disagrees with the platform about the resulting length. The core
    /// refuses to emit decorations from a desynced buffer; the host must resync.
    Desync { expected: u32, actual: u32 },
    OutOfBounds,
    /// Edits within one batch must not overlap — the inverse would be ambiguous, so
    /// the history could not undo them.
    Overlapping,
}

impl Text {
    pub fn new(s: impl Into<String>) -> Self {
        let mut t = Text { s: s.into(), lines: Vec::new(), len_utf16: 0 };
        t.reindex();
        t
    }

    pub fn as_str(&self) -> &str {
        &self.s
    }

    pub fn len_utf16(&self) -> u32 {
        self.len_utf16
    }

    pub fn is_empty(&self) -> bool {
        self.s.is_empty()
    }

    /// Apply edits, returning the **inverse** edits that would undo them.
    ///
    /// Input offsets are in the pre-edit document; the returned inverses are in the
    /// post-edit document, so they can be applied directly. `expected_len` is the
    /// platform's post-edit length in UTF-16 code units; disagreement means the mirror
    /// has drifted and is reported rather than silently producing wrong decorations.
    pub fn apply(
        &mut self,
        edits: &[Edit],
        expected_len: Option<u32>,
    ) -> Result<Vec<Edit>, EditError> {
        let mut asc: Vec<&Edit> = edits.iter().collect();
        asc.sort_by_key(|e| (e.start, e.end));
        for e in &asc {
            if e.start > e.end || e.end > self.len_utf16 {
                return Err(EditError::OutOfBounds);
            }
        }
        if asc.windows(2).any(|w| w[0].end > w[1].start) {
            return Err(EditError::Overlapping);
        }

        // Resolve every byte range against the *pre-edit* index before mutating, then
        // splice back-to-front so the earlier byte offsets stay valid.
        let spans: Vec<(usize, usize)> =
            asc.iter().map(|e| (self.utf16_to_utf8(e.start), self.utf16_to_utf8(e.end))).collect();

        let mut inverse = Vec::with_capacity(asc.len());
        let mut delta: i64 = 0;
        for (e, &(b0, b1)) in asc.iter().zip(&spans) {
            let replaced = self.s[b0..b1].to_string();
            let inserted = e.text.encode_utf16().count() as u32;
            let start = (e.start as i64 + delta) as u32;
            inverse.push(Edit { start, end: start + inserted, text: replaced });
            delta += inserted as i64 - (e.end - e.start) as i64;
        }

        for (e, &(b0, b1)) in asc.iter().zip(&spans).rev() {
            self.s.replace_range(b0..b1, &e.text);
        }
        self.reindex();

        if let Some(expected) = expected_len {
            if expected != self.len_utf16 {
                return Err(EditError::Desync { expected, actual: self.len_utf16 });
            }
        }
        Ok(inverse)
    }

    fn reindex(&mut self) {
        self.lines.clear();
        self.lines.push(Line { byte: 0, utf16: 0, ascii: true });
        let mut u16_off: u32 = 0;
        let mut ascii = true;
        for (byte_off, ch) in self.s.char_indices() {
            u16_off += ch.len_utf16() as u32;
            if !ch.is_ascii() {
                ascii = false;
            }
            if ch == '\n' {
                // Close the line that just ended, then open the next one.
                if let Some(last) = self.lines.last_mut() {
                    last.ascii = ascii;
                }
                let next = (byte_off + ch.len_utf8()) as u32;
                self.lines.push(Line { byte: next, utf16: u16_off, ascii: true });
                ascii = true;
            }
        }
        if let Some(last) = self.lines.last_mut() {
            last.ascii = ascii;
        }
        self.len_utf16 = u16_off;
    }

    /// UTF-8 byte offset -> UTF-16 code unit offset.
    pub fn utf8_to_utf16(&self, byte: usize) -> u32 {
        let byte = byte.min(self.s.len());
        let li = self.lines.partition_point(|l| (l.byte as usize) <= byte) - 1;
        let line = self.lines[li];
        if line.ascii {
            return line.utf16 + (byte as u32 - line.byte);
        }
        let mut u16_off = line.utf16;
        for ch in self.s[line.byte as usize..byte].chars() {
            u16_off += ch.len_utf16() as u32;
        }
        u16_off
    }

    /// UTF-16 code unit offset -> UTF-8 byte offset. An offset landing inside a
    /// surrogate pair snaps to the start of that character.
    pub fn utf16_to_utf8(&self, off: u32) -> usize {
        let off = off.min(self.len_utf16);
        let li = self.lines.partition_point(|l| l.utf16 <= off) - 1;
        let line = self.lines[li];
        if line.ascii {
            // The line's own length in bytes equals its length in UTF-16 units, so the
            // offset can only be past it if it lands on a later line — which the
            // partition point already ruled out.
            return (line.byte + (off - line.utf16)) as usize;
        }
        let (line_b, line_u16) = (line.byte, line.utf16);
        let mut u16_off = line_u16;
        for (byte_off, ch) in self.s[line_b as usize..].char_indices() {
            // `>` rather than `>=` so an offset landing *inside* a surrogate pair
            // resolves to the start of that character instead of overshooting to the
            // next one.
            if u16_off + ch.len_utf16() as u32 > off {
                return line_b as usize + byte_off;
            }
            u16_off += ch.len_utf16() as u32;
        }
        self.s.len()
    }

    /// Byte range of the line containing `byte`, excluding the trailing newline.
    pub fn line_range(&self, byte: usize) -> (usize, usize) {
        let byte = byte.min(self.s.len());
        let li = self.lines.partition_point(|l| (l.byte as usize) <= byte) - 1;
        let start = self.lines[li].byte as usize;
        let end = self
            .lines
            .get(li + 1)
            .map(|l| (l.byte as usize).saturating_sub(1))
            .unwrap_or(self.s.len());
        (start, end)
    }

    /// Byte offset each line starts at. Used by the incremental reparse to find a safe
    /// boundary without re-splitting the document.
    pub fn line_starts(&self) -> impl Iterator<Item = usize> + '_ {
        self.lines.iter().map(|l| l.byte as usize)
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_roundtrip_across_astral_planes() {
        // "a" + U+1F600 (surrogate pair, 2 u16 units) + "b"
        let t = Text::new("a\u{1F600}b");
        assert_eq!(t.len_utf16(), 4);
        assert_eq!(t.utf8_to_utf16(0), 0);
        assert_eq!(t.utf8_to_utf16(1), 1);
        assert_eq!(t.utf8_to_utf16(5), 3); // after the emoji
        assert_eq!(t.utf16_to_utf8(3), 5);
        // An offset inside the surrogate pair snaps back to the char start.
        assert_eq!(t.utf16_to_utf8(2), 1);
    }

    #[test]
    fn utf16_offsets_span_multiple_lines() {
        let t = Text::new("é\nx\u{1F600}\ny");
        assert_eq!(t.len_utf16(), 1 + 1 + 1 + 2 + 1 + 1);
        let b = t.utf16_to_utf8(3); // start of the emoji on line 2
        assert_eq!(&t.as_str()[b..b + 4], "\u{1F600}");
        assert_eq!(t.utf8_to_utf16(b), 3);
    }

    #[test]
    fn edits_apply_back_to_front() {
        let mut t = Text::new("hello world");
        t.apply(
            &[
                Edit { start: 0, end: 5, text: "goodbye".into() },
                Edit { start: 6, end: 11, text: "there".into() },
            ],
            None,
        )
        .unwrap();
        assert_eq!(t.as_str(), "goodbye there");
    }

    #[test]
    fn desync_is_reported_not_swallowed() {
        let mut t = Text::new("abc");
        let r = t.apply(&[Edit { start: 0, end: 0, text: "x".into() }], Some(99));
        assert_eq!(r, Err(EditError::Desync { expected: 99, actual: 4 }));
    }

    #[test]
    fn inverse_of_a_batch_restores_the_original() {
        for case in [
            ("hello world", vec![(0u32, 5u32, "goodbye"), (6, 11, "there")]),
            ("abc", vec![(1, 2, "")]),
            ("abc", vec![(3, 3, "def")]),
            ("a\u{1F600}b", vec![(1, 3, "x")]),
            ("one two three", vec![(0, 3, ""), (8, 13, "TEN")]),
        ] {
            let (src, spec) = case;
            let edits: Vec<Edit> = spec
                .iter()
                .map(|&(s, e, t)| Edit { start: s, end: e, text: t.into() })
                .collect();
            let mut t = Text::new(src);
            let inverse = t.apply(&edits, None).unwrap();
            assert_ne!(t.as_str(), src, "{src:?}: edit had no effect");
            t.apply(&inverse, None).unwrap();
            assert_eq!(t.as_str(), src, "{src:?}: inverse did not restore");
        }
    }

    #[test]
    fn overlapping_edits_are_rejected() {
        let mut t = Text::new("hello");
        let r = t.apply(
            &[
                Edit { start: 0, end: 3, text: "x".into() },
                Edit { start: 2, end: 5, text: "y".into() },
            ],
            None,
        );
        assert_eq!(r, Err(EditError::Overlapping));
        assert_eq!(t.as_str(), "hello", "a rejected batch must not mutate");
    }

    #[test]
    fn line_range_excludes_newline() {
        let t = Text::new("one\ntwo\nthree");
        assert_eq!(t.line_range(5), (4, 7));
        assert_eq!(&t.as_str()[4..7], "two");
    }
}
