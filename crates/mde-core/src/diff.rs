//! Decoration diffing (DESIGN §3.4).
//!
//! The whole point: a keystroke in paragraph 40 must not tear down the image widget
//! in paragraph 2. Entries whose identity is unchanged but whose position shifted are
//! reported as `moved`, which renderers apply without rebuilding the view.

use crate::decoration::{Decoration, Patch};
use crate::fasthash::FastMap;

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
    patch.moved.sort_unstable();
    patch
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
}
