//! Cheap audio features without ML: energy (RMS), brightness (spectral centroid), BPM (onset autocorrelation).
//! Used to pick a palette/params for generated covers when the GENRE tag is empty.
use crate::decode::Source;
use realfft::RealFftPlanner;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
pub struct Features {
    pub genre: String,
    pub energy: f32,
    pub bpm: f32,
    pub bright: f32,
    pub valence: f32,
}

pub fn analyze(path: &Path, dur: f64) -> Option<Features> {
    let mut src = Source::open(path).ok()?;
    let in_rate = src.rate as usize;
    // Work at ~11 kHz mono: features only need < 5 kHz, and this cuts the FFT work ~8x.
    let dec = (in_rate / 11025).max(1);
    let rate = (in_rate / dec) as f32;
    let secs = 8.0;
    let want = (rate * secs) as usize;
    let points: &[f64] = if dur > 40.0 { &[0.3, 0.55, 0.8] } else { &[0.0] };
    let mut mono: Vec<f32> = Vec::with_capacity(want * points.len());
    let (mut l, mut r) = (Vec::with_capacity(8192), Vec::with_capacity(8192));
    for &p in points {
        if dur > 40.0 && !src.seek(dur * p) {
            continue;
        }
        let start = mono.len();
        let (mut acc, mut k) = (0f32, 0usize);
        while mono.len() - start < want {
            l.clear();
            r.clear();
            if !src.next(&mut l, &mut r) {
                break;
            }
            for (a, b) in l.iter().zip(&r) {
                acc += a + b;
                k += 1;
                if k == dec {
                    mono.push(acc * 0.5 / dec as f32);
                    acc = 0.0;
                    k = 0;
                }
            }
        }
        mono.truncate(start + want.min(mono.len() - start));
    }
    if mono.len() < 2048 {
        return None;
    }
    // RMS energy -> 0..1 (-30 dBFS .. -6 dBFS)
    let rms = (mono.iter().map(|x| x * x).sum::<f32>() / mono.len() as f32).sqrt().max(1e-6);
    let db = 20.0 * rms.log10();
    let energy = ((db + 30.0) / 24.0).clamp(0.0, 1.0);

    // spectral centroid + flux envelope
    let n = 512;
    let hop = 128;
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let win: Vec<f32> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos()).collect();
    let mut inp = fft.make_input_vec();
    let mut spec = fft.make_output_vec();
    let mut prev = vec![0f32; n / 2 + 1];
    let mut flux = Vec::new();
    let (mut cen_sum, mut cen_w) = (0f64, 0f64);
    let mut i = 0;
    while i + n <= mono.len() {
        for k in 0..n {
            inp[k] = mono[i + k] * win[k];
        }
        if fft.process(&mut inp, &mut spec).is_err() {
            break;
        }
        let mut f = 0f32;
        let (mut num, mut den) = (0f64, 0f64);
        for (k, c) in spec.iter().enumerate() {
            let m = c.norm();
            num += (k as f64) * m as f64;
            den += m as f64;
            let d = m - prev[k];
            if d > 0.0 {
                f += d;
            }
            prev[k] = m;
        }
        if den > 0.0 {
            cen_sum += num / den * den;
            cen_w += den;
        }
        flux.push(f);
        i += hop;
    }
    let centroid_hz = if cen_w > 0.0 { (cen_sum / cen_w) as f32 * rate / n as f32 } else { 1500.0 };
    let bright = ((centroid_hz - 800.0) / 3200.0).clamp(0.0, 1.0);

    // BPM via autocorrelation of the onset envelope, 60..180 BPM
    let fps = rate / hop as f32;
    let mean = flux.iter().sum::<f32>() / flux.len().max(1) as f32;
    let env: Vec<f32> = flux.iter().map(|x| (x - mean).max(0.0)).collect();
    let (lo, hi) = ((fps * 60.0 / 180.0) as usize, (fps * 60.0 / 60.0) as usize);
    let mut best = (0usize, 0f32);
    for lag in lo.max(1)..hi.min(env.len().saturating_sub(1)) {
        let mut s = 0f32;
        for j in 0..env.len() - lag {
            s += env[j] * env[j + lag];
        }
        // mild preference for 90..140
        let bpm = 60.0 * fps / lag as f32;
        let w = 1.0 - ((bpm - 115.0).abs() / 200.0);
        if s * w > best.1 {
            best = (lag, s * w);
        }
    }
    let bpm = if best.0 > 0 { 60.0 * fps / best.0 as f32 } else { 100.0 };
    let valence = (0.25 + 0.4 * bright + 0.35 * ((bpm - 70.0) / 100.0).clamp(0.0, 1.0)).clamp(0.0, 1.0);

    let genre = if energy < 0.35 && bright < 0.35 {
        "Ambient"
    } else if energy < 0.45 && bright < 0.55 {
        if bpm < 100.0 { "Downtempo" } else { "Chillout" }
    } else if energy < 0.5 {
        "Acoustic"
    } else if bpm > 160.0 && energy > 0.6 {
        "Drum & Bass"
    } else if (118.0..=140.0).contains(&bpm) && energy > 0.6 && bright < 0.5 {
        "Techno"
    } else if (115.0..=130.0).contains(&bpm) && energy > 0.55 {
        "House"
    } else if bright > 0.6 && energy > 0.7 {
        "Rock"
    } else if bpm < 100.0 && energy > 0.6 {
        "Hip-Hop"
    } else {
        "Electronic"
    };
    Some(Features { genre: genre.into(), energy, bpm: bpm.round(), bright, valence })
}
