//! Volume leveling without tags (ported from the phone, src/mobile/backend/soundgenre.ts → loudnessOf):
//! integrated loudness per ITU-R BS.1770 / EBU R128 (K-weighting, 400 ms blocks with 75 % overlap, absolute −70 LUFS
//! and relative −10 LU gates) plus the sample peak. Measured in the background for songs without ReplayGain tags;
//! the player then applies a ReplayGain-like gain towards [`TARGET`] (the ReplayGain 2.0 reference level).
use crate::decode::Source;
use std::path::Path;

/// ReplayGain 2.0 reference (−18 LUFS), so measured songs sit at the same level as tagged ones.
pub const TARGET: f32 = -18.0;
/// at most this much quieter / louder than the file (dB); louder is also limited by the peak
pub const MAX_CUT: f32 = 12.0;
pub const MAX_BOOST: f32 = 6.0;

#[derive(Clone, Copy)]
struct Bq {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}
impl Bq {
    fn new(b: [f64; 5]) -> Bq {
        Bq { b0: b[0], b1: b[1], b2: b[2], a1: b[3], a2: b[4], x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }
    /// high shelf (+4 dB at 1681.97 Hz) — the "head" stage of the K-filter
    fn shelf(fs: f64) -> Bq {
        let (f0, q, g) = (1681.974450955533, 0.7071752369554196, 3.999843853973347);
        let w = 2.0 * std::f64::consts::PI * f0 / fs;
        let (cw, al) = (w.cos(), w.sin() / (2.0 * q));
        let a = 10f64.powf(g / 40.0);
        let sa = 2.0 * a.sqrt() * al;
        let a0 = (a + 1.0) - (a - 1.0) * cw + sa;
        Bq::new([
            a * ((a + 1.0) + (a - 1.0) * cw + sa) / a0,
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cw) / a0,
            a * ((a + 1.0) + (a - 1.0) * cw - sa) / a0,
            2.0 * ((a - 1.0) - (a + 1.0) * cw) / a0,
            ((a + 1.0) - (a - 1.0) * cw - sa) / a0,
        ])
    }
    /// high pass at 38 Hz — the "RLB" stage
    fn hp(fs: f64) -> Bq {
        let (f0, q) = (38.13547087602444, 0.5003270373238773);
        let w = 2.0 * std::f64::consts::PI * f0 / fs;
        let (cw, al) = (w.cos(), w.sin() / (2.0 * q));
        let a0 = 1.0 + al;
        Bq::new([(1.0 + cw) / 2.0 / a0, -(1.0 + cw) / a0, (1.0 + cw) / 2.0 / a0, -2.0 * cw / a0, (1.0 - al) / a0])
    }
    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Streaming meter: feed stereo chunks, then [`Meter::result`].
pub struct Meter {
    hop: usize,
    filt: [[Bq; 2]; 2],
    acc: f64,
    n: usize,
    chunks: Vec<f64>,
    peak: f32,
}
impl Meter {
    pub fn new(rate: u32) -> Meter {
        let fs = rate.max(8000) as f64;
        let k = [Bq::shelf(fs), Bq::hp(fs)];
        Meter { hop: (fs * 0.1).round() as usize, filt: [k, k], acc: 0.0, n: 0, chunks: Vec::new(), peak: 0.0 }
    }
    pub fn push(&mut self, l: &[f32], r: &[f32]) {
        for (a, b) in l.iter().zip(r) {
            self.peak = self.peak.max(a.abs()).max(b.abs());
            let x0 = self.filt[0][0].run(*a as f64);
            let x = self.filt[0][1].run(x0);
            let y0 = self.filt[1][0].run(*b as f64);
            let y = self.filt[1][1].run(y0);
            self.acc += x * x + y * y;
            self.n += 1;
            if self.n == self.hop {
                self.chunks.push(self.acc);
                self.acc = 0.0;
                self.n = 0;
            }
        }
    }
    /// (integrated loudness in LUFS, sample peak 0…1+) or None for silence / too short
    pub fn result(&self) -> Option<(f32, f32)> {
        let c = &self.chunks;
        let lk = |m: f64| -0.691 + 10.0 * (m + 1e-15).log10();
        let ms: Vec<f64> = (0..c.len().saturating_sub(3)).map(|b| (c[b] + c[b + 1] + c[b + 2] + c[b + 3]) / (4 * self.hop) as f64).filter(|m| lk(*m) > -70.0).collect();
        if ms.is_empty() {
            return None;
        }
        let mean = |a: &[f64]| a.iter().sum::<f64>() / a.len() as f64;
        let rel = lk(mean(&ms)) - 10.0;
        let g: Vec<f64> = ms.iter().copied().filter(|m| lk(*m) > rel).collect();
        let l = lk(mean(if g.is_empty() { &ms } else { &g }));
        Some((((l * 10.0).round() / 10.0) as f32, self.peak))
    }
}

/// Decodes the whole file (background thread). None if it can't be decoded or is silent.
pub fn measure(path: &Path) -> Option<(f32, f32)> {
    let mut src = Source::open(path).ok()?;
    let mut m = Meter::new(src.rate);
    let (mut l, mut r) = (Vec::with_capacity(8192), Vec::with_capacity(8192));
    loop {
        l.clear();
        r.clear();
        if !src.next(&mut l, &mut r) {
            break;
        }
        m.push(&l, &r);
    }
    m.result()
}

/// Linear gain for a measured song: towards TARGET, −12…+6 dB, never above full scale by the peak.
pub fn gain(lufs: f32, peak: f32) -> f32 {
    let db = (TARGET - lufs).clamp(-MAX_CUT, MAX_BOOST);
    let g = 10f32.powf(db / 20.0);
    if peak > 0.0 { g.min(1.0 / peak).max(10f32.powf(-MAX_CUT / 20.0)) } else { g.min(1.0) }
}

/// Album loudness from the songs' values (energy mean, as on the phone).
pub fn album(values: &[f32]) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    let e = values.iter().map(|x| 10f64.powf(*x as f64 / 10.0)).sum::<f64>() / values.len() as f64;
    Some((10.0 * e.log10()) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sine(fs: u32, f: f32, amp: f32, secs: f32) -> Vec<f32> {
        (0..(fs as f32 * secs) as usize).map(|i| amp * (2.0 * std::f32::consts::PI * f * i as f32 / fs as f32).sin()).collect()
    }
    #[test]
    fn full_scale_1k_sine_is_about_zero_lufs() {
        // BS.1770: a 0 dBFS 997 Hz sine in both channels reads ≈ 0 LUFS (−3 LUFS per channel)
        for fs in [44100, 48000, 96000] {
            let s = sine(fs, 997.0, 1.0, 5.0);
            let mut m = Meter::new(fs);
            m.push(&s, &s);
            let (l, p) = m.result().unwrap();
            assert!((l - 0.0).abs() < 0.5, "{fs}: {l}");
            assert!((p - 1.0).abs() < 0.01);
            let mut m = Meter::new(fs);
            let q: Vec<f32> = s.iter().map(|x| x * 0.1).collect(); // −20 dB
            m.push(&q, &q);
            assert!((m.result().unwrap().0 + 20.0).abs() < 0.5);
        }
    }
    #[test]
    fn silence_and_gain_limits() {
        let z = vec![0f32; 48000 * 2];
        let mut m = Meter::new(48000);
        m.push(&z, &z);
        assert!(m.result().is_none());
        assert!((gain(-18.0, 0.5) - 1.0).abs() < 1e-4);
        assert!((gain(-8.0, 1.0) - 10f32.powf(-10.0 / 20.0)).abs() < 1e-4); // loud master: −10 dB
        assert!((gain(-30.0, 0.2) - 10f32.powf(6.0 / 20.0)).abs() < 1e-3); // quiet: +6 dB max
        assert!((gain(-30.0, 0.9) - 1.0 / 0.9).abs() < 1e-3); // …but not above full scale
        assert!((album(&[-10.0, -10.0]).unwrap() + 10.0).abs() < 1e-3);
    }
}
