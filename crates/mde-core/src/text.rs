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
        // Typing is overwhelmingly one replacement. Re-index only the lines that
        // replacement can have changed, then slide the untouched suffix. Rebuilding
        // every line made a one-character edit O(document) before parsing even began.
        if let ([edit], [inverse], [(b0, b1)]) = (edits, inverse.as_slice(), spans.as_slice()) {
            self.reindex_edit(*b0, *b1, edit, inverse.text.encode_utf16().count() as u32);
        } else {
            self.reindex();
        }

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

    /// Repair the line index after one edit whose byte range was measured in the old
    /// string. Lines before the edit are reused verbatim; lines after it only need
    /// their cumulative offsets shifted.
    fn reindex_edit(&mut self, old_start: usize, old_end: usize, edit: &Edit, removed_u16: u32) {
        let first = self.lines.partition_point(|l| (l.byte as usize) <= old_start) - 1;
        // Include the line containing the end point. In particular, deleting a newline
        // merges the line that started at `old_end` into the edited line.
        let suffix = self.lines.partition_point(|l| (l.byte as usize) <= old_end);
        let scan_start = self.lines[first].byte as usize;
        let old_scan_end = self.lines.get(suffix).map(|l| l.byte as usize).unwrap_or_else(|| {
            // Recover the old length from the already-mutated string.
            let byte_delta = edit.text.len() as isize - (old_end - old_start) as isize;
            (self.s.len() as isize - byte_delta) as usize
        });

        let byte_delta = edit.text.len() as isize - (old_end - old_start) as isize;
        let inserted_u16 = edit.text.encode_utf16().count() as isize;
        let utf16_delta = inserted_u16 - removed_u16 as isize;
        let new_scan_end = (old_scan_end as isize + byte_delta) as usize;
        let base_utf16 = self.lines[first].utf16;

        let mut replacement = Vec::new();
        if scan_start < new_scan_end || suffix == self.lines.len() {
            replacement.push(Line { byte: scan_start as u32, utf16: base_utf16, ascii: true });
            let mut u16_off = base_utf16;
            let mut ascii = true;
            for (relative, ch) in self.s[scan_start..new_scan_end].char_indices() {
                u16_off += ch.len_utf16() as u32;
                if !ch.is_ascii() { ascii = false; }
                if ch == '\n' {
                    replacement.last_mut().expect("the edited range has a line").ascii = ascii;
                    let next = scan_start + relative + ch.len_utf8();
                    // When a reusable suffix exists, its first line already represents
                    // this boundary. At EOF the terminal empty line belongs to us.
                    if next < new_scan_end || suffix == self.lines.len() {
                        replacement.push(Line { byte: next as u32, utf16: u16_off, ascii: true });
                    }
                    ascii = true;
                }
            }
            if let Some(last) = replacement.last_mut() {
                last.ascii = self.s[last.byte as usize..new_scan_end].is_ascii();
            }
        }

        for line in &mut self.lines[suffix..] {
            line.byte = (line.byte as isize + byte_delta) as u32;
            line.utf16 = (line.utf16 as isize + utf16_delta) as u32;
        }
        self.lines.splice(first..suffix, replacement);
        self.len_utf16 = (self.len_utf16 as isize + utf16_delta) as u32;
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

    /// Convert many UTF-8 offsets in one forward pass.
    ///
    /// The ordinary single-offset path is ideal for short lines, but a giant Unicode
    /// paragraph with thousands of decorations otherwise rescans the same prefix for
    /// every endpoint. Sorting the requests once makes that case O(text + n log n)
    /// instead of O(text * n).
    pub fn utf8_offsets_to_utf16(&self, offsets: &[usize]) -> Vec<u32> {
        let mut order: Vec<usize> = (0..offsets.len()).collect();
        order.sort_unstable_by_key(|&index| offsets[index]);
        let mut converted = vec![0; offsets.len()];
        let mut byte = 0usize;
        let mut utf16 = 0u32;

        for index in order {
            let target = offsets[index].min(self.s.len());
            debug_assert!(self.s.is_char_boundary(target));
            for ch in self.s[byte..target].chars() {
                utf16 += ch.len_utf16() as u32;
            }
            byte = target;
            converted[index] = utf16;
        }
        converted
    }

    /// Whether a full emission would repeatedly scan a pathologically long Unicode
    /// line. Short and ASCII lines retain the lower-overhead point conversion path.
    pub fn benefits_from_batched_utf16(&self, endpoint_count: usize) -> bool {
        endpoint_count >= 64
            && self.lines.iter().enumerate().any(|(index, line)| {
                let end = self
                    .lines
                    .get(index + 1)
                    .map_or(self.s.len(), |next| next.byte as usize);
                !line.ascii && end.saturating_sub(line.byte as usize) >= 4 * 1024
            })
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
    fn batched_utf16_conversion_matches_individual_offsets() {
        let text = Text::new("ASCII résumé 日本語 🎉\nsecond line");
        let offsets: Vec<_> = text
            .as_str()
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(text.as_str().len()))
            .rev()
            .collect();
        let expected: Vec<_> = offsets
            .iter()
            .map(|&offset| text.utf8_to_utf16(offset))
            .collect();
        assert_eq!(text.utf8_offsets_to_utf16(&offsets), expected);
    }

    #[test]
    fn only_large_unicode_lines_select_batched_conversion() {
        assert!(!Text::new("résumé").benefits_from_batched_utf16(100));
        assert!(!Text::new("x".repeat(8 * 1024)).benefits_from_batched_utf16(100));
        assert!(!Text::new("é".repeat(4 * 1024)).benefits_from_batched_utf16(2));
        assert!(Text::new("é".repeat(4 * 1024)).benefits_from_batched_utf16(100));
    }

    fn assert_same_index(actual: &Text, expected: &Text) {
        assert_eq!(actual.s, expected.s);
        assert_eq!(actual.len_utf16, expected.len_utf16);
        assert_eq!(actual.lines.len(), expected.lines.len());
        for (a, b) in actual.lines.iter().zip(&expected.lines) {
            assert_eq!((a.byte, a.utf16, a.ascii), (b.byte, b.utf16, b.ascii));
        }
        for byte in 0..=actual.s.len() {
            if actual.s.is_char_boundary(byte) {
                assert_eq!(actual.utf8_to_utf16(byte), expected.utf8_to_utf16(byte));
            }
        }
        for offset in 0..=actual.len_utf16 {
            assert_eq!(actual.utf16_to_utf8(offset), expected.utf16_to_utf8(offset));
        }
    }

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
    fn one_edit_repairs_only_the_affected_lines() {
        let cases = [
            ("alpha\nbeta\ngamma", 7, 7, "😀\nnew "),
            ("alpha\nbeta\ngamma", 5, 6, ""),
            ("alpha\nbeta\ngamma", 0, 6, ""),
            ("alpha\nbeta\n", 11, 11, "tail"),
            ("één\n日本\nlast", 1, 5, "x\ny"),
            ("a\nb\nc", 2, 4, ""),
        ];
        for (source, start, end, inserted) in cases {
            let mut actual = Text::new(source);
            actual.apply(&[Edit { start, end, text: inserted.into() }], None).unwrap();
            let expected = Text::new(actual.as_str());
            assert_same_index(&actual, &expected);
        }
    }

    #[test]
    fn incremental_index_matches_full_reindex_through_random_edits() {
        let mut actual = Text::new("alpha\nβeta\n日本語\n😀 end\n");
        let mut seed = 0x9e37_79b9_u32;
        let insertions = ["x", "\n", "😀", "é", "", "two\nlines"];
        for _ in 0..2_000 {
            let boundaries: Vec<u32> = actual
                .as_str()
                .char_indices()
                .map(|(byte, _)| actual.utf8_to_utf16(byte))
                .chain(std::iter::once(actual.len_utf16()))
                .collect();
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let a = boundaries[(seed as usize) % boundaries.len()];
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let b = boundaries[(seed as usize) % boundaries.len()];
            let start = a.min(b);
            let end = a.max(b);
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let text = insertions[(seed as usize) % insertions.len()].to_string();
            actual.apply(&[Edit { start, end, text }], None).unwrap();
            let expected = Text::new(actual.as_str());
            assert_same_index(&actual, &expected);
        }
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
