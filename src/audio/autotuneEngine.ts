import { AutotuneSettings, MusicalKey, MusicalScale } from '../types/studio';
import { detectFramePitchHz } from './dspAnalysis';

const KEY_OFFSET: Record<MusicalKey, number> = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
};

const SCALE_NOTES: Record<MusicalScale, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const MUSICAL_KEYS = Object.keys(KEY_OFFSET) as MusicalKey[];
const MUSICAL_SCALES = Object.keys(SCALE_NOTES) as MusicalScale[];

function finiteInRange(value: number | null | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

/** Sanitize persisted/imported settings before they enter the DSP path. */
function normalizeAutotuneSettings(settings: AutotuneSettings): AutotuneSettings {
  const raw = settings as AutotuneSettings | null | undefined;
  const key = raw && MUSICAL_KEYS.includes(raw.key) ? raw.key : 'C';
  const scale = raw && MUSICAL_SCALES.includes(raw.scale) ? raw.scale : 'minor';
  return {
    enabled: raw?.enabled === true,
    retuneSpeedMs: finiteInRange(raw?.retuneSpeedMs, 18, 0, 120),
    mix: finiteInRange(raw?.mix, 0, 0, 1),
    humanize: finiteInRange(raw?.humanize, 0, 0, 1),
    key,
    scale,
    // Formant preservation is not implemented by the current grain-resampling DSP.
    // Keep this disabled rather than implying that the setting changes the sound.
    preserveFormants: false,
  };
}

function quantizeHzToScale(
  hz: number,
  key: MusicalKey,
  scale: MusicalScale,
  humanize: number
): number {
  if (hz <= 0) return 0;
  const midiFloat = 69 + 12 * Math.log2(hz / 440);
  const root = KEY_OFFSET[key];
  const allowed = SCALE_NOTES[scale];

  let bestMidi = Math.round(midiFloat);
  let bestDist = Infinity;

  const baseOctave = Math.floor(midiFloat / 12) - 1;
  for (let oct = baseOctave - 1; oct <= baseOctave + 1; oct++) {
    for (const interval of allowed) {
      const candidate = (oct + 1) * 12 + root + interval;
      const dist = Math.abs(midiFloat - candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestMidi = candidate;
      }
    }
  }

  // Humanize preserves subtle micro-vibrato near the target note
  const correctedMidi = bestMidi + (midiFloat - bestMidi) * Math.min(0.45, humanize * 0.45);
  return 440 * Math.pow(2, (correctedMidi - 69) / 12);
}

/**
 * Overlap-add pitch-correction processor. It retains the input duration and
 * frame timing, but grain resampling can change formants; it does not provide
 * independent formant preservation.
 */
export function processVocalWithAutotune(
  ctx: BaseAudioContext,
  input: AudioBuffer,
  settings: AutotuneSettings
): AudioBuffer {
  const safeSettings = normalizeAutotuneSettings(settings);
  if (!safeSettings.enabled || safeSettings.mix <= 0.01) {
    return input;
  }

  const sr = input.sampleRate;
  const numChannels = input.numberOfChannels;
  const len = input.length;
  const output = ctx.createBuffer(numChannels, len, sr);

  // Frame parameters tuned for clean vocal preservation and fast mobile execution.
  // Short recordings must not silently bypass tuning: use the whole available
  // buffer as one smaller frame when it cannot hold the nominal analysis window.
  const targetFrameSize = Math.min(2048, Math.max(1024, Math.pow(2, Math.round(Math.log2(sr * 0.042)))));
  const frameSize = Math.min(targetFrameSize, len);
  // The detector needs at least two minimum-period spans to estimate pitch.
  // For buffers shorter than that, returning the original audio is safer than
  // producing unstable pitch decisions from an undersized frame.
  if (frameSize < Math.max(256, Math.ceil((sr / 460) * 2))) {
    return input;
  }
  const hopSize = Math.max(1, Math.floor(frameSize / 4));

  // Hann analysis/synthesis window
  const window = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));
  }

  // Retune smoothing factor derived from retuneSpeedMs
  const hopMs = (hopSize / sr) * 1000;
  const alpha = safeSettings.retuneSpeedMs <= 1 ? 1 : Math.min(1, hopMs / safeSettings.retuneSpeedMs);

  // Analyse a mono fold-down so stereo recordings are not tuned from
  // the left channel alone. This avoids incorrect pitch decisions when
  // the vocal is panned or the channels contain slightly different takes.
  const mono = new Float32Array(len);
  let strongestChannel = input.getChannelData(0);
  let strongestEnergy = 0;
  let monoEnergy = 0;
  for (let ch = 0; ch < numChannels; ch++) {
    const channel = input.getChannelData(ch);
    let channelEnergy = 0;
    for (let i = 0; i < len; i++) {
      const sample = channel[i];
      mono[i] += sample / numChannels;
      channelEnergy += sample * sample;
    }
    if (channelEnergy > strongestEnergy) {
      strongestEnergy = channelEnergy;
      strongestChannel = channel;
    }
  }
  for (let i = 0; i < len; i++) monoEnergy += mono[i] * mono[i];
  // Protect pitch detection from phase-cancelled stereo fold-downs.
  if (strongestEnergy > 0 && monoEnergy < strongestEnergy * 0.0625) {
    mono.set(strongestChannel);
  }

  // Build explicit frame positions and always include a frame anchored at
  // the final complete window. A regular hop grid can leave up to hopSize
  // samples at the end outside every analysis/synthesis frame.
  const frameStarts: number[] = [];
  if (len >= frameSize) {
    for (let start = 0; start + frameSize <= len; start += hopSize) {
      frameStarts.push(start);
    }
    const finalStart = len - frameSize;
    if (frameStarts[frameStarts.length - 1] !== finalStart) {
      frameStarts.push(finalStart);
    }
  }
  const frameCount = frameStarts.length;
  const ratios = new Float32Array(frameCount);
  let smoothedRatio = 1;
  let lastVoicedRatio = 1;
  let unvoicedFrameCount = 0;
  // Keep the last reliable note across tiny consonant gaps. Releasing to
  // uncorrected pitch on every missed frame can create audible pitch flutter.
  const shortGapHoldFrames = 2;

  for (let f = 0; f < frameCount; f++) {
    const start = frameStarts[f];
    const { hz, confidence } = detectFramePitchHz(mono, start, frameSize, sr);
    let targetRatio = 1;
    const isReliableVoicedFrame = hz > 70 && confidence > 0.56;

    if (isReliableVoicedFrame) {
      const targetHz = quantizeHzToScale(hz, safeSettings.key, safeSettings.scale, safeSettings.humanize);
      if (targetHz > 0) {
        targetRatio = Math.max(0.72, Math.min(1.38, targetHz / hz));
        lastVoicedRatio = targetRatio;
        unvoicedFrameCount = 0;
      } else {
        unvoicedFrameCount++;
      }
    } else {
      unvoicedFrameCount++;
    }

    if (!isReliableVoicedFrame && unvoicedFrameCount <= shortGapHoldFrames) {
      targetRatio = lastVoicedRatio;
    }

    smoothedRatio = smoothedRatio + alpha * (targetRatio - smoothedRatio);
    ratios[f] = smoothedRatio;
  }

  const wetMix = safeSettings.mix;
  const dryMix = 1 - wetMix;

  for (let ch = 0; ch < numChannels; ch++) {
    const inData = input.getChannelData(ch);
    const wetAcc = new Float32Array(len);
    const normAcc = new Float32Array(len);

    for (let f = 0; f < frameCount; f++) {
      const start = frameStarts[f];
      const ratio = ratios[f];

      // If essentially unshifted, copy windowed frame cleanly
      if (Math.abs(ratio - 1) < 0.004) {
        for (let i = 0; i < frameSize; i++) {
          const w = window[i];
          wetAcc[start + i] += inData[start + i] * w * w;
          normAcc[start + i] += w * w;
        }
        continue;
      }

      // Resample grain inside frame window while maintaining frame duration/rhythm
      const half = frameSize * 0.5;
      for (let i = 0; i < frameSize; i++) {
        const w = window[i];
        const srcPos = half + (i - half) * ratio;
        let sample = 0;
        if (srcPos >= 0 && srcPos < frameSize - 1) {
          const idx0 = start + Math.floor(srcPos);
          const frac = srcPos - Math.floor(srcPos);
          if (idx0 >= 0 && idx0 + 1 < len) {
            sample = inData[idx0] * (1 - frac) + inData[idx0 + 1] * frac;
          }
        }
        wetAcc[start + i] += sample * w * w;
        normAcc[start + i] += w * w;
      }
    }

    const outData = output.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const wet = normAcc[i] > 1e-4 ? wetAcc[i] / normAcc[i] : inData[i];
      outData[i] = inData[i] * dryMix + wet * wetMix;
    }
  }

  return output;
}
