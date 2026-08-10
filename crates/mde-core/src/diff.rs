//! Decoration diffing (DESIGN §3.4).
//!
//! The whole point: a keystroke in paragraph 40 must not tear down the image widget
//! in paragraph 2. Entries whose identity is unchanged but whose position shifted are
//! reported as compact suffix shifts or explicit `moved` entries, which renderers
//! apply without rebuilding the view.

use crate::decoration::{Decoration, Patch, Shift};
use crate::fasthash::FastMap;
use std::collections::BTreeMap;

/// True when two decorations differ in a way the renderer cannot absorb by moving.
fn needs_rebuild(a: &Decoration, b: &Decoration) -> bool {
    a.kind != b.kind
        || a.role != b.role
        || a.reveal != b.reveal
        || a.depth != b.depth
        || a.layer != b.layer
}

pub fn diff(prev: &[Decoration], next: &[Decoration]) -> Patch {
    let mut patch = Patch::default();
    let mut old: FastMap<u64, &Decoration> = FastMap::with_capacity_and_hasher(prev.len(), Default::default());
    for d in prev {
        old.insert(d.key, d);
    }

    for d in next {
        match old.remove(&d.key) {
            None => patch.added.push(*d),
            Some(p) => {
                if needs_rebuild(p, d) {
                    patch.removed.push(p.key);
                    patch.added.push(*d);
                } else if p.start != d.start || p.end != d.end {
                    patch.moved.push((d.key, d.start, d.end));
                }
            }
        }
    }
    patch.removed.extend(old.into_keys());
    patch.removed.sort_unstable();
    compact_suffix_shift(prev, next, &mut patch);
    patch.moved.sort_unstable();
    patch
}

/// Replace a large run of identical moves with one suffix translation.
///
/// Most decorations take the shared translation. Any survivor that does not is kept
/// (or added) as an explicit move, which overrides the shift in the renderer. This
/// handles overlapping nodes and repeated-sibling identity changes without giving up
/// the compression of the common suffix.
fn compact_suffix_shift(prev: &[Decoration], next: &[Decoration], patch: &mut Patch) {
    const MIN_COMPACTED_MOVES: usize = 8;
    if patch.moved.len() < MIN_COMPACTED_MOVES { return; }

    let mut old_by_key = FastMap::with_capacity_and_hasher(prev.len(), Default::default());
    let mut new_by_key = FastMap::with_capacity_and_hasher(next.len(), Default::default());
    for d in prev { old_by_key.insert(d.key, d); }
    for d in next { new_by_key.insert(d.key, d); }

    let mut counts = BTreeMap::<i32, usize>::new();
    for &(key, start, end) in &patch.moved {
        let Some(old) = old_by_key.get(&key) else { continue };
        let ds = start as i64 - old.start as i64;
        let de = end as i64 - old.end as i64;
        if ds == de && ds != 0 && i32::try_from(ds).is_ok() {
            *counts.entry(ds as i32).or_default() += 1;
        }
    }
    let Some((&delta, &count)) = counts
        .iter()
        .max_by_key(|&(delta, count)| (*count, -i64::from(*delta)))
    else { return };
    if count < MIN_COMPACTED_MOVES { return; }

    let cutoff = patch
        .moved
        .iter()
        .filter_map(|(key, start, end)| {
            let old = old_by_key.get(key)?;
            let translated = *start as i64 - old.start as i64 == i64::from(delta)
                && *end as i64 - old.end as i64 == i64::from(delta);
            translated.then_some(old.start)
        })
        .min()
        .expect("the winning translation has at least one move");

    let overrides: Vec<_> = prev
        .iter()
        .filter(|old| old.start >= cutoff)
        .filter_map(|old| {
            let new = new_by_key.get(&old.key)?;
            if needs_rebuild(old, new) { return None; }
            let translated = new.start as i64 - old.start as i64 == i64::from(delta)
                && new.end as i64 - old.end as i64 == i64::from(delta);
            (!translated).then_some((new.key, new.start, new.end))
        })
        .collect();

    // Existing non-uniform moves already count against the wire size. Only unchanged
    // exceptions need a new record; require a real reduction before adding the shift.
    let moved_keys: FastMap<_, _> = patch
        .moved
        .iter()
        .map(|(key, _, _)| (*key, ()))
        .collect();
    let new_override_count = overrides
        .iter()
        .filter(|(key, _, _)| !moved_keys.contains_key(key))
        .count();
    if count <= new_override_count + 1 { return; }

    patch.moved.retain(|(key, start, end)| {
        let Some(old) = old_by_key.get(key) else { return true };
        !(old.start >= cutoff
            && *start as i64 - old.start as i64 == i64::from(delta)
            && *end as i64 - old.end as i64 == i64::from(delta))
    });
    for item in overrides {
        if !moved_keys.contains_key(&item.0) {
            patch.moved.push(item);
        }
    }
    patch.shifted.push(Shift { start: cutoff, delta });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decoration::{Kind, Reveal, RoleId};

    fn d(key: u64, start: u32, end: u32) -> Decoration {
        Decoration::new(start, end, Kind::Style, 1 as RoleId, key)
    }

    #[test]
    fn unchanged_produces_an_empty_patch() {
        let a = vec![d(1, 0, 5), d(2, 6, 9)];
        assert!(diff(&a, &a).is_empty());
    }

    #[test]
    fn a_shift_is_a_move_not_a_rebuild() {
        let prev = vec![d(1, 0, 5)];
        let next = vec![d(1, 3, 8)];
        let p = diff(&prev, &next);
        assert_eq!(p.moved, vec![(1, 3, 8)]);
        assert!(p.added.is_empty() && p.removed.is_empty());
    }

    #[test]
    fn a_kind_change_rebuilds() {
        let prev = vec![d(1, 0, 5)];
        let mut n = d(1, 0, 5);
        n.kind = Kind::Conceal;
        let p = diff(&prev, &[n]);
        assert_eq!(p.removed, vec![1]);
        assert_eq!(p.added.len(), 1);
    }

    #[test]
    fn a_reveal_change_rebuilds() {
        let prev = vec![d(1, 0, 5)];
        let n = d(1, 0, 5).with_reveal(Reveal::CaretInNode);
        let p = diff(&prev, &[n]);
        assert_eq!(p.removed, vec![1]);
    }

    #[test]
    fn removals_and_additions_are_reported() {
        let prev = vec![d(1, 0, 5), d(2, 6, 9)];
        let next = vec![d(2, 6, 9), d(3, 10, 12)];
        let p = diff(&prev, &next);
        assert_eq!(p.removed, vec![1]);
        assert_eq!(p.added.len(), 1);
        assert_eq!(p.added[0].key, 3);
    }

    #[test]
    fn a_large_uniform_suffix_is_one_shift() {
        let prev: Vec<_> = (0..12).map(|i| d(i, i as u32 * 10, i as u32 * 10 + 5)).collect();
        let mut next = prev.clone();
        for item in &mut next[2..] {
            item.start += 3;
            item.end += 3;
        }

        let p = diff(&prev, &next);
        assert_eq!(p.shifted, vec![Shift { start: 20, delta: 3 }]);
        assert!(p.moved.is_empty());
    }

    #[test]
    fn a_large_negative_suffix_shift_is_compacted() {
        let prev: Vec<_> = (0..12).map(|i| d(i, 20 + i as u32 * 10, 25 + i as u32 * 10)).collect();
        let mut next = prev.clone();
        for item in &mut next[2..] {
            item.start -= 3;
            item.end -= 3;
        }

        let p = diff(&prev, &next);
        assert_eq!(p.shifted, vec![Shift { start: 40, delta: -3 }]);
        assert!(p.moved.is_empty());
    }

    #[test]
    fn a_node_spanning_the_shift_cutoff_keeps_an_explicit_move() {
        let mut prev: Vec<_> = (0..10).map(|i| d(i, 20 + i as u32 * 10, 25 + i as u32 * 10)).collect();
        prev.push(d(99, 5, 25));
        let mut next = prev.clone();
        for item in &mut next[..10] {
            item.start += 4;
            item.end += 4;
        }
        next[10].end += 4;

        let p = diff(&prev, &next);
        assert_eq!(p.shifted, vec![Shift { start: 20, delta: 4 }]);
        assert_eq!(p.moved, vec![(99, 5, 29)]);
    }

    #[test]
    fn one_unshifted_survivor_is_an_explicit_override() {
        let prev: Vec<_> = (0..10).map(|i| d(i, i as u32 * 10, i as u32 * 10 + 5)).collect();
        let mut next = prev.clone();
        for item in &mut next[1..9] {
            item.start += 2;
            item.end += 2;
        }

        let p = diff(&prev, &next);
        assert_eq!(p.shifted, vec![Shift { start: 10, delta: 2 }]);
        assert_eq!(p.moved, vec![(9, 90, 95)]);
    }
}
