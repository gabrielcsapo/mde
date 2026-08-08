//! A hasher for keys that are already hashes.
//!
//! `HashMap`'s default is SipHash, chosen to resist collision attacks from untrusted
//! input. Decoration keys are not untrusted input — the core produced them itself, by
//! hashing (DESIGN §3.3) — so they are already well distributed, and re-hashing them
//! costs real time: the per-keystroke diff at 1 MB spends more than half its time in
//! SipHash over 50 000 `u64`s.
//!
//! This applies a single multiply-xorshift (fibonacci hashing) so the high bits, which
//! `HashMap` uses for bucket selection, still vary with every input bit.

use std::hash::{BuildHasherDefault, Hasher};

pub type FastMap<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<FastHasher>>;

#[derive(Default)]
pub struct FastHasher(u64);

impl Hasher for FastHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        // Only the integer paths below are used in this crate. Bytes get a plain FNV-1a
        // so the type is still a correct `Hasher` if someone reaches for it.
        for &b in bytes {
            self.0 = (self.0 ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn write_u64(&mut self, n: u64) {
        // 2^64 / golden ratio: spreads sequential and clustered inputs across the whole
        // range, and the xorshift moves entropy into the high bits `HashMap` indexes by.
        let mixed = n.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        self.0 = mixed ^ (mixed >> 32);
    }

    fn write_u32(&mut self, n: u32) {
        self.write_u64(u64::from(n));
    }

    fn write_usize(&mut self, n: usize) {
        self.write_u64(n as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bucket selection uses the high bits, so inputs that differ only in the low bits
    /// must not collide there — the failure mode would be a map that degrades to a list.
    #[test]
    fn sequential_keys_spread_across_the_high_bits() {
        let mut seen = std::collections::HashSet::new();
        for i in 0..10_000u64 {
            let mut h = FastHasher::default();
            h.write_u64(i);
            seen.insert(h.finish() >> 52);
        }
        assert!(seen.len() > 4_000, "only {} distinct high-bit buckets", seen.len());
    }

    #[test]
    fn it_behaves_as_a_map_key() {
        let mut map: FastMap<u64, u32> = FastMap::default();
        for i in 0..1_000u64 {
            map.insert(i.wrapping_mul(0x1234_5678_9abc_def0), i as u32);
        }
        assert_eq!(map.len(), 1_000);
        for i in 0..1_000u64 {
            assert_eq!(map.get(&i.wrapping_mul(0x1234_5678_9abc_def0)), Some(&(i as u32)));
        }
    }
}
