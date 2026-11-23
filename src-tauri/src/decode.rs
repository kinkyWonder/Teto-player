//! symphonia-based decoder producing planar stereo f32 at the source rate.
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, SampleBuffer, SignalSpec};
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SErr;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

pub struct Source {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    pub rate: u32,
    pub channels: usize,
    buf: Option<SampleBuffer<f32>>,
    skip: u64, // frames to drop after an inexact seek
}

#[derive(Debug)]
pub enum OpenErr {
    NotFound,
    Unsupported(String),
}

impl Source {
    pub fn open(path: &Path) -> Result<Source, OpenErr> {
        let f = File::open(path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { OpenErr::NotFound } else { OpenErr::Unsupported(e.to_string()) })?;
        let mss = MediaSourceStream::new(Box::new(f), MediaSourceStreamOptions { buffer_len: 256 * 1024 });
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
            .map_err(|e| OpenErr::Unsupported(e.to_string()))?;
        let format = probed.format;
        let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or(OpenErr::Unsupported("нет аудиодорожки".into()))?;
        let track_id = track.id;
        let rate = track.codec_params.sample_rate.unwrap_or(44100);
        let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| OpenErr::Unsupported(e.to_string()))?;
        Ok(Source { format, decoder, track_id, rate, channels, buf: None, skip: 0 })
    }

    pub fn seek(&mut self, secs: f64) -> bool {
        let r = self.format.seek(SeekMode::Accurate, SeekTo::Time { time: Time::from(secs.max(0.0)), track_id: Some(self.track_id) });
        self.decoder.reset();
        match r {
            Ok(s) => {
                self.skip = s.required_ts.saturating_sub(s.actual_ts);
                true
            }
            Err(_) => false,
        }
    }

    /// Decode next chunk into `l`/`r` (appends). Returns false at end of stream.
    pub fn next(&mut self, l: &mut Vec<f32>, r: &mut Vec<f32>) -> bool {
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SErr::IoError(_)) | Err(SErr::ResetRequired) => return false,
                Err(_) => return false,
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            match self.decoder.decode(&packet) {
                Ok(buf) => {
                    let (ch, rate) = push(&mut self.buf, &mut self.skip, buf, l, r);
                    if ch > 0 {
                        self.channels = ch;
                        self.rate = rate;
                    }
                    return true;
                }
                Err(SErr::DecodeError(_)) => continue, // skip corrupt frame
                Err(SErr::IoError(_)) => return false,
                Err(_) => return false,
            }
        }
    }
}

fn push(sbuf: &mut Option<SampleBuffer<f32>>, skip: &mut u64, buf: AudioBufferRef, l: &mut Vec<f32>, r: &mut Vec<f32>) -> (usize, u32) {
    let spec: SignalSpec = *buf.spec();
    let frames = buf.frames();
    if frames == 0 {
        return (0, 0);
    }
    let chn = spec.channels.count().max(1);
    let sb = match sbuf {
        Some(b) if b.capacity() >= frames * chn => b,
        _ => {
            *sbuf = Some(SampleBuffer::<f32>::new(buf.capacity() as u64, spec));
            sbuf.as_mut().unwrap()
        }
    };
    sb.copy_interleaved_ref(buf);
    let ch = chn;
    let s = sb.samples();
    let mut start = 0usize;
    if *skip > 0 {
        let k = (*skip as usize).min(frames);
        *skip -= k as u64;
        start = k;
    }
    l.reserve(frames - start);
    r.reserve(frames - start);
    match ch {
        1 => {
            for f in start..frames {
                l.push(s[f]);
                r.push(s[f]);
            }
        }
        2 => {
            for f in start..frames {
                l.push(s[f * 2]);
                r.push(s[f * 2 + 1]);
            }
        }
        _ => {
            // simple downmix: FL/FR + 0.707 * (C + surrounds)
            for f in start..frames {
                let b = &s[f * ch..f * ch + ch];
                let c = if ch > 2 { b[2] * 0.707 } else { 0.0 };
                let (sl, sr) = if ch >= 6 { (b[4] * 0.5, b[5] * 0.5) } else if ch >= 4 { (b[ch - 2] * 0.5, b[ch - 1] * 0.5) } else { (0.0, 0.0) };
                l.push((b[0] + c + sl) * 0.6);
                r.push((b[1] + c + sr) * 0.6);
            }
        }
    }
    (ch, spec.rate)
}
