import {
  DspVocalMetrics,
  MusicalKey,
  MusicalScale,
  PauseRegion,
} from '../types/studio';

const NOTE_NAMES: MusicalKey[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALE_INTERVALS: Record<MusicalScale, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

function getMonoData(buffer: AudioBuffer): Float32Array {
  const channelCount = Math.max(1, buffer.numberOfChannels);
  const firstChannel = buffer.getChannelData(0);
  if (channelCount === 1) return firstChannel;

  // Fold down every channel, not only L/R. This keeps pitch and level analysis
  // consistent for multichannel recordings imported from external sources.
  const out = new Float32Array(buffer.length);
  let strongestChannel = firstChannel;
  let strongestEnergy = 0;
  let monoEnergy = 0;

  for (let channel = 0; channel < channelCount; channel++) {
    const data = buffer.getChannelData(channel);
    let channelEnergy = 0;
    for (let i = 0; i < data.length; i++) {
      const sample = data[i];
      out[i] += sample / channelCount;
      channelEnergy += sample * sample;
    }
    if (channelEnergy > strongestEnergy) {
      strongestEnergy = channelEnergy;
      strongestChannel = data;
    }
  }

  for (let i = 0; i < out.length; i++) monoEnergy += out[i] * out[i];

  // Averaging stereo channels can cancel a vocal that was recorded with
  // opposite polarity on the left and right channels. Fall back to the
  // strongest channel only when the fold-down loses most of its energy.
  if (strongestEnergy > 0 && monoEnergy < strongestEnergy * 0.0625) {
    return new Float32Array(strongestChannel);
  }
  return out;
}

/**
 * Autocorrelation pitch detector for a single frame (75 Hz - 460 Hz).
 */
export function detectFramePitchHz(
  samples: Float32Array,
  startIdx: number,
  frameSize: number,
  sampleRate: number
): { hz: number; confidence: number } {
  const minLag = Math.floor(sampleRate / 460);
  const maxLag = Math.min(Math.floor(sampleRate / 75), Math.floor(frameSize / 2));
  // A frame ending exactly at samples.length is valid; reject only frames that overflow.
  if (startIdx < 0 || frameSize <= 0 || startIdx + frameSize > samples.length) {
    return { hz: 0, confidence: 0 };
  }

  let energy = 0;
  for (let i = 0; i < frameSize; i++) {
    const v = samples[startIdx + i];
    energy += v * v;
  }
  const rms = Math.sqrt(energy / frameSize);
  // Quiet but clean takes are common on phone microphones. The previous
  // 0.015 threshold rejected many usable vocals recorded at low input gain.
  // Keep a conservative floor for silence/noise while accepting quieter takes.
  if (rms < 0.003) return { hz: 0, confidence: 0 };

  let bestLag = 0;
  let bestCorr = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let cross = 0;
    let normA = 0;
    let normB = 0;
    const len = frameSize - lag;
    for (let i = 0; i < len; i++) {
      const a = samples[startIdx + i];
      const b = samples[startIdx + i + lag];
      cross += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    const corr = denom > 1e-8 ? cross / denom : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestLag === 0 || bestCorr < 0.52) {
    return { hz: 0, confidence: bestCorr };
  }

  return { hz: sampleRate / bestLag, confidence: bestCorr };
}

export function analyzeVocalBuffer(buffer: AudioBuffer): DspVocalMetrics {
  const mono = getMonoData(buffer);
  const sr = buffer.sampleRate;
  const durationSec = buffer.duration;

  // 1. Frame-by-frame RMS energy (20ms windows)
  const winLen = Math.max(128, Math.floor(sr * 0.02));
  const numFrames = Math.floor(mono.length / winLen);
  const frameRms = new Float32Array(numFrames);
  let peakAmp = 0;
  let sumSq = 0;

  for (let f = 0; f < numFrames; f++) {
    let s = 0;
    const base = f * winLen;
    for (let i = 0; i < winLen; i++) {
      const v = mono[base + i];
      const av = Math.abs(v);
      if (av > peakAmp) peakAmp = av;
      s += v * v;
      sumSq += v * v;
    }
    frameRms[f] = Math.sqrt(s / winLen);
  }

  const avgRms = Math.sqrt(sumSq / Math.max(1, mono.length));
  const rmsPeakDb = peakAmp > 1e-6 ? 20 * Math.log10(peakAmp) : -90;
  const rmsAvgDb = avgRms > 1e-6 ? 20 * Math.log10(avgRms) : -90;

  // 2. Detect voice entries and pauses (adaptive noise floor)
  const silenceThresh = Math.max(0.012, avgRms * 0.25);
  const pauses: PauseRegion[] = [];
  const entries: number[] = [];
  let inVoice = false;
  let pauseStartSec = 0;

  for (let f = 0; f < numFrames; f++) {
    const t = (f * winLen) / sr;
    const voiced = frameRms[f] > silenceThresh;
    if (voiced && !inVoice) {
      inVoice = true;
      entries.push(Number(t.toFixed(2)));
      if (t - pauseStartSec >= 0.28 && pauseStartSec > 0.05) {
        pauses.push({
          startSec: Number(pauseStartSec.toFixed(2)),
          endSec: Number(t.toFixed(2)),
        });
      }
    } else if (!voiced && inVoice) {
      inVoice = false;
      pauseStartSec = t;
    }
  }
  if (!inVoice && durationSec - pauseStartSec >= 0.35 && pauseStartSec > 0.05) {
    pauses.push({
      startSec: Number(pauseStartSec.toFixed(2)),
      endSec: Number(durationSec.toFixed(2)),
    });
  }

  // 3. 32-slice normalized energy curve
  const energyCurve: number[] = [];
  const sliceFrames = Math.max(1, Math.floor(numFrames / 32));
  let maxSlice = 1e-6;
  const rawSlices: number[] = [];
  for (let s = 0; s < 32; s++) {
    const start = s * sliceFrames;
    const end = Math.min(numFrames, start + sliceFrames);
    let acc = 0;
    for (let i = start; i < end; i++) acc += frameRms[i];
    const mean = acc / Math.max(1, end - start);
    if (mean > maxSlice) maxSlice = mean;
    rawSlices.push(mean);
  }
  for (const val of rawSlices) {
    energyCurve.push(Number((val / maxSlice).toFixed(2)));
  }

  // 4. Pitch histogram -> key & scale estimation
  const pitchClassCounts = new Float32Array(12);
  const pitches: number[] = [];
  const pitchFrameSize = Math.min(2048, Math.max(1024, Math.floor(sr * 0.045)));
  const hop = Math.floor(sr * 0.04);

  // Include a final frame that ends exactly at the final sample.
  for (let idx = 0; idx + pitchFrameSize <= mono.length; idx += hop) {
    const { hz, confidence } = detectFramePitchHz(mono, idx, pitchFrameSize, sr);
    if (hz > 70 && confidence > 0.55) {
      pitches.push(hz);
      const midi = Math.round(69 + 12 * Math.log2(hz / 440));
      const pc = ((midi % 12) + 12) % 12;
      pitchClassCounts[pc] += confidence;
    }
  }

  pitches.sort((a, b) => a - b);
  const medianPitchHz = pitches.length ? Math.round(pitches[Math.floor(pitches.length / 2)]) : 0;

  let detectedKey: MusicalKey = 'C';
  let detectedScale: MusicalScale = 'minor';
  let bestScore = -Infinity;

  const candidateScales: MusicalScale[] = ['minor', 'harmonic_minor', 'phrygian', 'dorian', 'major'];
  for (let root = 0; root < 12; root++) {
    for (const sc of candidateScales) {
      const intervals = SCALE_INTERVALS[sc];
      let inScale = 0;
      let outScale = 0;
      for (let pc = 0; pc < 12; pc++) {
        const rel = ((pc - root) % 12 + 12) % 12;
        if (intervals.includes(rel)) {
          inScale += pitchClassCounts[pc] * (rel === 0 ? 1.35 : rel === 7 ? 1.15 : 1);
        } else {
          outScale += pitchClassCounts[pc] * 1.1;
        }
      }
      const score = inScale - outScale;
      if (score > bestScore) {
        bestScore = score;
        detectedKey = NOTE_NAMES[root];
        detectedScale = sc;
      }
    }
  }

  // 5. Estimate BPM from vocal onset intervals
  const onsetTimes: number[] = [];
  let prevEnergy = 0;
  for (let f = 1; f < numFrames; f++) {
    const diff = frameRms[f] - prevEnergy;
    if (diff > Math.max(0.025, avgRms * 0.45)) {
      const t = (f * winLen) / sr;
      if (!onsetTimes.length || t - onsetTimes[onsetTimes.length - 1] > 0.14) {
        onsetTimes.push(t);
      }
    }
    prevEnergy = frameRms[f];
  }

  let estimatedBpm = 136;
  if (onsetTimes.length >= 4) {
    const iois: number[] = [];
    for (let i = 1; i < onsetTimes.length; i++) {
      const dt = onsetTimes[i] - onsetTimes[i - 1];
      if (dt >= 0.18 && dt <= 1.2) iois.push(dt);
    }
    if (iois.length > 0) {
      const bpmCandidates: Record<number, number> = {};
      for (const dt of iois) {
        let bpm = 60 / dt;
        while (bpm < 96) bpm *= 2;
        while (bpm > 172) bpm /= 2;
        const rounded = Math.round(bpm / 2) * 2;
        bpmCandidates[rounded] = (bpmCandidates[rounded] || 0) + 1;
      }
      let topBpm = 136;
      let topCount = -1;
      for (const [b, c] of Object.entries(bpmCandidates)) {
        if (c > topCount) {
          topCount = c;
          topBpm = Number(b);
        }
      }
      estimatedBpm = topBpm;
    }
  }

  return {
    durationSec: Number(durationSec.toFixed(2)),
    sampleRate: sr,
    rmsPeakDb: Number(rmsPeakDb.toFixed(1)),
    rmsAvgDb: Number(rmsAvgDb.toFixed(1)),
    estimatedBpm,
    detectedKey,
    detectedScale,
    medianPitchHz,
    entryTimestampsSec: entries.slice(0, 24),
    pauses: pauses.slice(0, 16),
    energyCurve,
  };
}

export interface DetectedMouthHit {
  timeSec: number;
  lowRatio: number;
  midRatio: number;
  highRatio: number;
  peak: number;
}

/**
 * Extracts real percussive mouth transients ("bum", "dum", "pá", "tchá")
 * along with 3-band spectral balance for each hit.
 */
export function analyzeMouthBeatBuffer(buffer: AudioBuffer): {
  hits: DetectedMouthHit[];
  estimatedBpm: number;
} {
  const mono = getMonoData(buffer);
  const sr = buffer.sampleRate;
  const winLen = Math.max(128, Math.floor(sr * 0.01)); // 10ms resolution
  const numFrames = Math.floor(mono.length / winLen);

  // Simple 1-pole lowpass (220Hz) & highpass (2200Hz) across full signal for band energy
  const lpAlpha = Math.exp((-2 * Math.PI * 220) / sr);
  const hpAlpha = Math.exp((-2 * Math.PI * 2200) / sr);

  const lowSig = new Float32Array(mono.length);
  const highSig = new Float32Array(mono.length);
  let lpPrev = 0;
  let hpPrev = 0;
  let xPrev = 0;

  for (let i = 0; i < mono.length; i++) {
    const x = mono[i];
    lpPrev = (1 - lpAlpha) * x + lpAlpha * lpPrev;
    lowSig[i] = lpPrev;

    const hp = hpAlpha * (hpPrev + x - xPrev);
    hpPrev = hp;
    xPrev = x;
    highSig[i] = hp;
  }

  const frameRms = new Float32Array(numFrames);
  let maxRms = 0;
  for (let f = 0; f < numFrames; f++) {
    const base = f * winLen;
    let sum = 0;
    for (let i = 0; i < winLen; i++) {
      const v = mono[base + i];
      sum += v * v;
    }
    const r = Math.sqrt(sum / winLen);
    frameRms[f] = r;
    if (r > maxRms) maxRms = r;
  }

  const hits: DetectedMouthHit[] = [];
  const onsetThresh = Math.max(0.025, maxRms * 0.14);
  let lastHitSec = -1;

  for (let f = 1; f < numFrames - 1; f++) {
    const prev = frameRms[f - 1];
    const curr = frameRms[f];
    const timeSec = (f * winLen) / sr;
    const isAttack = curr > onsetThresh && curr - prev > onsetThresh * 0.35;

    if (isAttack && timeSec - lastHitSec > 0.075) {
      // Measure 45ms window after attack for low / mid / high ratio
      const startSample = f * winLen;
      const evalLen = Math.min(mono.length - startSample, Math.floor(sr * 0.045));
      let eLow = 0;
      let eHigh = 0;
      let eTotal = 0;
      let peak = 0;
      for (let i = 0; i < evalLen; i++) {
        const idx = startSample + i;
        const m = mono[idx];
        const l = lowSig[idx];
        const h = highSig[idx];
        eTotal += m * m;
        eLow += l * l;
        eHigh += h * h;
        if (Math.abs(m) > peak) peak = Math.abs(m);
      }
      const denom = Math.max(1e-7, eTotal);
      const lowRatio = Math.min(1, eLow / denom);
      const highRatio = Math.min(1, eHigh / denom);
      const midRatio = Math.max(0, 1 - lowRatio - highRatio);

      hits.push({
        timeSec: Number(timeSec.toFixed(3)),
        lowRatio: Number(lowRatio.toFixed(2)),
        midRatio: Number(midRatio.toFixed(2)),
        highRatio: Number(highRatio.toFixed(2)),
        peak: Number(Math.min(1, peak).toFixed(2)),
      });
      lastHitSec = timeSec;
    }
  }

  // Estimate BPM from mouth hit spacing
  let estimatedBpm = 132;
  if (hits.length >= 4) {
    const counts: Record<number, number> = {};
    for (let i = 1; i < hits.length; i++) {
      const dt = hits[i].timeSec - hits[i - 1].timeSec;
      if (dt > 0.15 && dt < 1.1) {
        let bpm = 60 / dt;
        while (bpm < 95) bpm *= 2;
        while (bpm > 170) bpm /= 2;
        const b = Math.round(bpm / 2) * 2;
        counts[b] = (counts[b] || 0) + 1;
      }
    }
    let best = 132;
    let maxC = -1;
    for (const [b, c] of Object.entries(counts)) {
      if (c > maxC) {
        maxC = c;
        best = Number(b);
      }
    }
    estimatedBpm = best;
  }

  return { hits: hits.slice(0, 96), estimatedBpm };
}
