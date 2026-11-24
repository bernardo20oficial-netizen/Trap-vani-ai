import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT_DIR = path.resolve('public/audio/kit');
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith('.wav')) {
    fs.unlinkSync(path.join(OUT_DIR, f));
  }
}

const SR = 44100;

function writeWav(filename, floatSamples, peakTarget = 0.9) {
  let maxAbs = 0;
  for (let i = 0; i < floatSamples.length; i++) {
    const a = Math.abs(floatSamples[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 1e-6 ? peakTarget / maxAbs : 1;

  const pcm = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i] * scale));
    pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);

  const full = Buffer.concat([header, Buffer.from(pcm.buffer)]);
  fs.writeFileSync(path.join(OUT_DIR, filename), full);

  const hash = crypto.createHash('sha256').update(full).digest('hex').slice(0, 12);
  return {
    filename,
    bytes: full.length,
    durationSec: (floatSamples.length / SR).toFixed(3),
    hash,
  };
}

// Deterministic seeded PRNG so studio samples are reproducible and clean
function createRng(seed = 20261117) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

function onePoleLP(samples, cutoffHz) {
  const alpha = Math.exp((-2 * Math.PI * cutoffHz) / SR);
  const out = new Float32Array(samples.length);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    prev = (1 - alpha) * samples[i] + alpha * prev;
    out[i] = prev;
  }
  return out;
}

function onePoleHP(samples, cutoffHz) {
  const alpha = Math.exp((-2 * Math.PI * cutoffHz) / SR);
  const out = new Float32Array(samples.length);
  let prevY = 0;
  let prevX = 0;
  for (let i = 0; i < samples.length; i++) {
    const y = alpha * (prevY + samples[i] - prevX);
    prevY = y;
    prevX = samples[i];
    out[i] = y;
  }
  return out;
}

function biquadBandpass(samples, freqHz, q = 1.2) {
  const w0 = (2 * Math.PI * freqHz) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;

  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function applyTailFade(samples, fadeMs = 10) {
  const fadeLen = Math.min(samples.length, Math.floor((SR * fadeMs) / 1000));
  for (let i = 0; i < fadeLen; i++) {
    samples[samples.length - 1 - i] *= i / fadeLen;
  }
  return samples;
}

/**
 * 1. Punchy Modern Trap Kick
 * Focused chest punch around 70-115Hz with 62Hz high-pass filter and tight 145ms envelope
 * so it hits hard right above the 808 sub without phase cancellation or low-end mud.
 */
function buildTrapKick() {
  const dur = 0.165;
  const len = Math.floor(SR * dur);
  const out = new Float32Array(len);
  const rng = createRng(101);
  let phase = 0;

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // Fast exponential pitch sweep 195Hz -> 68Hz
    const freq = 68 + 128 * Math.exp(-t / 0.015);
    phase += (2 * Math.PI * freq) / SR;

    const env = (t < 0.0012 ? t / 0.0012 : 1) * Math.exp(-t / 0.042);
    const body = Math.sin(phase) + 0.16 * Math.sin(phase * 2);

    // Crisp beater click in first 4ms
    const clickEnv = Math.exp(-t / 0.0018);
    const click = (Math.sin(2 * Math.PI * 1850 * t) * 0.36 + rng() * 0.22) * clickEnv;

    out[i] = Math.tanh((body * env + click * 0.52) * 1.65);
  }
  return applyTailFade(onePoleHP(onePoleLP(out, 3400), 62), 14);
}

/**
 * 2. Crisp Atlanta Trap Snare
 * Tight 200Hz snap + controlled 2.2kHz snare wire crack + crisp 5.4kHz air.
 */
function buildTrapSnare() {
  const dur = 0.195;
  const len = Math.floor(SR * dur);
  const rng = createRng(202);
  const rawNoise = new Float32Array(len);
  const body = new Float32Array(len);
  let phase = 0;

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const freq = 165 + 72 * Math.exp(-t / 0.014);
    phase += (2 * Math.PI * freq) / SR;
    const bodyEnv = (t < 0.001 ? t / 0.001 : 1) * Math.exp(-t / 0.025);
    body[i] = (Math.sin(phase) + 0.32 * Math.sin(phase * 1.5)) * bodyEnv;

    const noiseEnv = (t < 0.0012 ? t / 0.0012 : 1) * Math.exp(-t / 0.045);
    rawNoise[i] = rng() * noiseEnv;
  }

  const wireMid = biquadBandpass(rawNoise, 2250, 0.9);
  const wireAir = onePoleHP(rawNoise, 5400);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Math.tanh((body[i] * 0.88 + wireMid[i] * 1.08 + wireAir[i] * 0.56) * 1.35);
  }
  return applyTailFade(onePoleHP(out, 135), 14);
}

/**
 * 3. Layered Studio Trap Clap
 * Clean 4-burst transient spread + smooth filtered tail (no harsh resonant spike).
 */
function buildTrapClap() {
  const dur = 0.21;
  const len = Math.floor(SR * dur);
  const rng = createRng(303);
  const raw = new Float32Array(len);
  const burstStarts = [0, 0.008, 0.017, 0.025];

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let burstEnv = 0;
    for (let b = 0; b < burstStarts.length; b++) {
      const dt = t - burstStarts[b];
      if (dt >= 0) {
        const decay = b === 3 ? 0.045 : 0.006;
        const weight = b === 3 ? 1.0 : 0.68;
        burstEnv += weight * Math.exp(-dt / decay);
      }
    }
    raw[i] = rng() * burstEnv;
  }

  const bp = biquadBandpass(raw, 1600, 0.82);
  const air = biquadBandpass(raw, 3500, 0.95);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Math.tanh((bp[i] * 1.05 + air[i] * 0.5) * 1.28);
  }
  return applyTailFade(onePoleHP(out, 320), 16);
}

/**
 * 4 & 5. Crisp Metallic Trap Hi-Hats (Closed & Open)
 * Clean metallic air without harsh aliasing spikes on rapid rolls.
 */
function buildTrapHiHat(isOpen) {
  const dur = isOpen ? 0.32 : 0.042;
  const decay = isOpen ? 0.095 : 0.0095;
  const len = Math.floor(SR * dur);
  const rng = createRng(isOpen ? 405 : 404);
  const raw = new Float32Array(len);
  const metallicFreqs = [312.4, 461.8, 628.5, 824.1, 1126.3, 1492.0];

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = (t < 0.0008 ? t / 0.0008 : 1) * Math.exp(-t / decay);
    let metal = 0;
    for (let k = 0; k < metallicFreqs.length; k++) {
      metal += Math.tanh(2.1 * Math.sin(2 * Math.PI * metallicFreqs[k] * t));
    }
    metal /= metallicFreqs.length;
    const hiss = rng();
    raw[i] = (metal * 0.44 + hiss * 0.78) * env;
  }

  const hp = onePoleHP(raw, isOpen ? 7000 : 7800);
  const shimmer = biquadBandpass(hp, 10200, 0.72);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = hp[i] * 0.72 + shimmer[i] * 0.4;
  }
  return applyTailFade(out, isOpen ? 18 : 6);
}

/**
 * 6. Woody Trap Rimshot / Perc
 */
function buildTrapRim() {
  const dur = 0.075;
  const len = Math.floor(SR * dur);
  const out = new Float32Array(len);
  const rng = createRng(505);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = (t < 0.0008 ? t / 0.0008 : 1) * Math.exp(-t / 0.013);
    const tone =
      Math.sin(2 * Math.PI * 485 * t) * 0.65 +
      Math.sin(2 * Math.PI * 1320 * t) * 0.4 +
      rng() * 0.14 * Math.exp(-t / 0.0045);
    out[i] = Math.tanh(tone * 1.32) * env;
  }
  return applyTailFade(onePoleHP(out, 280), 8);
}

/**
 * 7. Warm Dark Trap Felt Bell / Rhodes Pluck (C5 = 523.251 Hz, MIDI 72)
 * Centered at C5 so playing C4..D5 runs at 0.5x..1.12x speed without shrill pitch-up chirping.
 */
function buildTrapBell() {
  const dur = 0.92;
  const len = Math.floor(SR * dur);
  const f0 = 523.251; // C5 (MIDI 72)
  const out = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const att = t < 0.009 ? t / 0.009 : 1;
    const bodyEnv = att * Math.exp(-t / 0.28);
    const chimeEnv = att * Math.exp(-t / 0.085);

    // Subtle warm chorus detune + soft electric tine attack (zero harsh metallic chirp)
    const fundamental =
      Math.sin(2 * Math.PI * f0 * t) * 0.68 +
      Math.sin(2 * Math.PI * (f0 * 1.0025) * t) * 0.24;
    const secondHarm = Math.sin(2 * Math.PI * (f0 * 2.0) * t) * 0.18 * chimeEnv;
    const thirdHarm = Math.sin(2 * Math.PI * (f0 * 3.0) * t) * 0.05 * Math.exp(-t / 0.035);

    out[i] = (fundamental + secondHarm + thirdHarm) * bodyEnv;
  }
  return applyTailFade(onePoleHP(onePoleLP(out, 2100), 220), 36);
}

const kitReport = [
  writeWav('kick_trap_pro.wav', buildTrapKick(), 0.88),
  writeWav('snare_trap_pro.wav', buildTrapSnare(), 0.86),
  writeWav('clap_trap_pro.wav', buildTrapClap(), 0.82),
  writeWav('hihat_closed_pro.wav', buildTrapHiHat(false), 0.72),
  writeWav('hihat_open_pro.wav', buildTrapHiHat(true), 0.70),
  writeWav('perc_rim_pro.wav', buildTrapRim(), 0.78),
  writeWav('bell_trap_pro.wav', buildTrapBell(), 0.80),
];

console.table(kitReport);
console.log(`Generated ${kitReport.length} studio kit WAV files in ${OUT_DIR}`);
