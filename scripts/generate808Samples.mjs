import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT_DIR = path.resolve('public/audio/808');
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith('.wav')) {
    fs.unlinkSync(path.join(OUT_DIR, f));
  }
}

const SR = 44100;

function writeWav(filename, floatSamples) {
  let maxAbs = 0;
  for (let i = 0; i < floatSamples.length; i++) {
    const a = Math.abs(floatSamples[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 1e-6 ? 0.90 / maxAbs : 1;

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

  let sumSq = 0;
  for (let i = 0; i < floatSamples.length; i++) {
    const v = floatSamples[i] * scale;
    sumSq += v * v;
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(sumSq / floatSamples.length) + 1e-9);
  const hash = crypto.createHash('sha256').update(full).digest('hex').slice(0, 12);
  return {
    filename,
    bytes: full.length,
    durationSec: (floatSamples.length / SR).toFixed(2),
    rmsDb: rmsDb.toFixed(1),
    hash,
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

/**
 * Clean, phase-accurate studio 808 synthesis builder.
 * Every sample has an authentic Trap 808 tone (zero sci-fi noise) with distinct
 * attack transient, harmonic recipe, saturation curve, decay profile, and pitch contour.
 */
function buildTrap808({
  durationSec,
  rootHz = 65.406, // C2
  pitchSweepHz = 95,
  pitchSweepMs = 17,
  attackMs = 2.5,
  sustainSec = 0,
  decaySec = 0.55,
  h2 = 0.2,
  h3 = 0.08,
  h4 = 0,
  h5 = 0,
  drive = 1.4,
  asymmetry = 0,
  transientKnock = 0,
  transientFreq = 185,
  lowpassHz = 950,
  highpassHz = 28,
  warmDetune = 0,
  pitchCurveFn = null,
}) {
  const len = Math.floor(SR * durationSec);
  const out = new Float32Array(len);
  let phase = 0;
  let phase2 = 0;
  const sweepS = pitchSweepMs / 1000;
  const attackS = attackMs / 1000;

  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let freq = rootHz + pitchSweepHz * Math.exp(-t / sweepS);
    if (pitchCurveFn) {
      freq = pitchCurveFn(t, freq);
    }
    phase = (phase + (2 * Math.PI * freq) / SR) % (2 * Math.PI);
    if (warmDetune > 0) {
      phase2 = (phase2 + (2 * Math.PI * freq * (1 + warmDetune)) / SR) % (2 * Math.PI);
    }

    const att = t < attackS ? t / attackS : 1;
    let rel = 1;
    if (t > sustainSec) {
      rel = Math.exp(-(t - sustainSec) / decaySec);
    }
    const amp = att * rel;

    let raw =
      Math.sin(phase) +
      h2 * Math.sin(phase * 2) +
      h3 * Math.sin(phase * 3) +
      h4 * Math.sin(phase * 4) +
      h5 * Math.sin(phase * 5);

    if (warmDetune > 0) {
      raw = raw * 0.84 + Math.sin(phase2) * 0.22;
    }

    if (transientKnock > 0 && t < 0.028) {
      const kEnv = Math.exp(-t / 0.0048);
      raw += transientKnock * Math.sin(2 * Math.PI * transientFreq * t) * kEnv;
    }

    const driven =
      asymmetry !== 0
        ? raw >= 0
          ? Math.tanh(raw * (drive + asymmetry))
          : Math.tanh(raw * drive)
        : Math.tanh(raw * drive);

    out[i] = driven * amp;
  }

  const fadeLen = Math.min(len, Math.floor(SR * 0.018));
  for (let i = 0; i < fadeLen; i++) {
    out[len - 1 - i] *= i / fadeLen;
  }

  return onePoleHP(onePoleLP(out, lowpassHz), highpassHz);
}

const F1 = 43.654;  // MIDI 29
const Fs1 = 46.249; // MIDI 30
const G1 = 48.999;  // MIDI 31
const Gs1 = 51.913; // MIDI 32
const A1 = 55.0;    // MIDI 33
const As1 = 58.270; // MIDI 34
const C2 = 65.406;  // MIDI 36
const D2 = 73.416;  // MIDI 38

const specs = [
  // === PACK 1: TRAP AMERICANO MODERNO (9) ===
  {
    file: '808_trap_americano.wav',
    cfg: { durationSec: 1.22, rootHz: C2, pitchSweepHz: 120, pitchSweepMs: 15, attackMs: 2, sustainSec: 0.1, decaySec: 0.48, h2: 0.28, h3: 0.11, drive: 1.75, transientKnock: 0.42, lowpassHz: 1250 },
  },
  {
    file: '808_atl_808_mafia.wav',
    cfg: { durationSec: 1.32, rootHz: C2, pitchSweepHz: 140, pitchSweepMs: 14, attackMs: 1.5, sustainSec: 0.15, decaySec: 0.5, h2: 0.34, h3: 0.16, drive: 2.25, transientKnock: 0.58, transientFreq: 165, lowpassHz: 1400 },
  },
  {
    file: '808_metro_sub.wav',
    cfg: { durationSec: 1.48, rootHz: C2, pitchSweepHz: 75, pitchSweepMs: 18, attackMs: 3.5, sustainSec: 0.28, decaySec: 0.54, h2: 0.22, h3: 0.08, drive: 1.55, transientKnock: 0.25, lowpassHz: 920 },
  },
  {
    file: '808_detroit_bounce.wav',
    cfg: { durationSec: 0.42, rootHz: C2, pitchSweepHz: 170, pitchSweepMs: 12, attackMs: 1.5, sustainSec: 0, decaySec: 0.125, h2: 0.26, h3: 0.1, drive: 1.9, transientKnock: 0.48, lowpassHz: 1450 },
  },
  {
    file: '808_southside_knock.wav',
    cfg: { durationSec: 1.08, rootHz: C2, pitchSweepHz: 195, pitchSweepMs: 11, attackMs: 1.2, sustainSec: 0.06, decaySec: 0.42, h2: 0.31, h3: 0.14, h4: 0.05, drive: 2.1, transientKnock: 0.65, transientFreq: 210, lowpassHz: 1650 },
  },
  {
    file: '808_west_modern_clean.wav',
    cfg: { durationSec: 1.18, rootHz: C2, pitchSweepHz: 62, pitchSweepMs: 19, attackMs: 4, sustainSec: 0.16, decaySec: 0.46, h2: 0.24, h3: 0.06, drive: 1.38, transientKnock: 0.18, lowpassHz: 820 },
  },
  {
    file: '808_wheezy_warm_sub.wav',
    cfg: { durationSec: 1.26, rootHz: A1, pitchSweepHz: 95, pitchSweepMs: 16, attackMs: 3, sustainSec: 0.14, decaySec: 0.48, h2: 0.32, h3: 0.09, drive: 1.65, warmDetune: 0.0018, lowpassHz: 980 },
  },
  {
    file: '808_future_low_boom.wav',
    cfg: { durationSec: 1.44, rootHz: G1, pitchSweepHz: 115, pitchSweepMs: 17, attackMs: 2.5, sustainSec: 0.24, decaySec: 0.56, h2: 0.29, h3: 0.12, drive: 1.95, transientKnock: 0.36, transientFreq: 170, lowpassHz: 1050 },
  },
  {
    file: '808_baby_tight_knock.wav',
    cfg: { durationSec: 0.88, rootHz: C2, pitchSweepHz: 150, pitchSweepMs: 12, attackMs: 1.4, sustainSec: 0.04, decaySec: 0.32, h2: 0.35, h3: 0.15, drive: 2.15, transientKnock: 0.52, transientFreq: 195, lowpassHz: 1520 },
  },

  // === PACK 2: EXPLOSIVOS, DISTORCIDOS & AGRESSIVOS (9) ===
  {
    file: '808_explosivo_atlanta.wav',
    cfg: { durationSec: 1.45, rootHz: C2, pitchSweepHz: 145, pitchSweepMs: 16, attackMs: 2, sustainSec: 0.22, decaySec: 0.58, h2: 0.34, h3: 0.16, drive: 2.35, transientKnock: 0.45, lowpassHz: 1150 },
  },
  {
    file: '808_explosivo_sub_boom.wav',
    cfg: { durationSec: 1.68, rootHz: A1, pitchSweepHz: 160, pitchSweepMs: 18, attackMs: 2, sustainSec: 0.4, decaySec: 0.6, h2: 0.38, h3: 0.2, drive: 2.65, transientKnock: 0.62, transientFreq: 155, lowpassHz: 1080 },
  },
  {
    file: '808_distorcido_agressivo.wav',
    cfg: { durationSec: 1.05, rootHz: C2, pitchSweepHz: 125, pitchSweepMs: 15, attackMs: 2, sustainSec: 0.12, decaySec: 0.42, h2: 0.42, h3: 0.28, drive: 4.1, asymmetry: 1.4, transientKnock: 0.3, lowpassHz: 2400 },
  },
  {
    file: '808_fita_saturada.wav',
    cfg: { durationSec: 1.3, rootHz: C2, pitchSweepHz: 105, pitchSweepMs: 17, attackMs: 3, sustainSec: 0.18, decaySec: 0.52, h2: 0.36, h3: 0.2, drive: 2.9, asymmetry: 0.5, lowpassHz: 1600 },
  },
  {
    file: '808_agressivo_clip.wav',
    cfg: { durationSec: 0.96, rootHz: C2, pitchSweepHz: 155, pitchSweepMs: 13, attackMs: 1.5, sustainSec: 0.14, decaySec: 0.36, h2: 0.48, h3: 0.31, h4: 0.14, drive: 4.6, asymmetry: 1.1, transientKnock: 0.4, lowpassHz: 2650 },
  },
  {
    file: '808_impacto_ataque.wav',
    cfg: { durationSec: 1.15, rootHz: C2, pitchSweepHz: 210, pitchSweepMs: 12, attackMs: 1, sustainSec: 0.08, decaySec: 0.44, h2: 0.28, h3: 0.12, drive: 1.95, transientKnock: 0.72, lowpassHz: 1850 },
  },
  {
    file: '808_overdrive_crunch_c2.wav',
    cfg: { durationSec: 1.12, rootHz: C2, pitchSweepHz: 132, pitchSweepMs: 14, attackMs: 1.6, sustainSec: 0.16, decaySec: 0.4, h2: 0.44, h3: 0.29, h4: 0.11, drive: 3.7, asymmetry: 0.85, transientKnock: 0.38, lowpassHz: 2150 },
  },
  {
    file: '808_sub_nuclear_f1.wav',
    cfg: { durationSec: 1.8, rootHz: F1, pitchSweepHz: 145, pitchSweepMs: 21, attackMs: 2.2, sustainSec: 0.52, decaySec: 0.62, h2: 0.36, h3: 0.22, drive: 3.0, asymmetry: 0.7, transientKnock: 0.5, transientFreq: 148, lowpassHz: 1120, highpassHz: 25 },
  },
  {
    file: '808_fuzz_trap_saturado.wav',
    cfg: { durationSec: 1.0, rootHz: A1, pitchSweepHz: 118, pitchSweepMs: 15, attackMs: 2, sustainSec: 0.18, decaySec: 0.38, h2: 0.52, h3: 0.35, h4: 0.18, h5: 0.08, drive: 4.9, asymmetry: 1.5, lowpassHz: 2800 },
  },

  // === PACK 3: LEVES, LIMPOS, SUAVES & TRAP MELODICO (8) ===
  {
    file: '808_limpo_estudio.wav',
    cfg: { durationSec: 1.1, rootHz: C2, pitchSweepHz: 42, pitchSweepMs: 19, attackMs: 7, sustainSec: 0.08, decaySec: 0.48, h2: 0.12, h3: 0.02, drive: 1.05, lowpassHz: 440 },
  },
  {
    file: '808_leve_aereo.wav',
    cfg: { durationSec: 0.92, rootHz: C2, pitchSweepHz: 32, pitchSweepMs: 21, attackMs: 9, sustainSec: 0.05, decaySec: 0.38, h2: 0.09, h3: 0.01, drive: 1.02, lowpassHz: 380 },
  },
  {
    file: '808_melodico_puro.wav',
    cfg: { durationSec: 1.65, rootHz: C2, pitchSweepHz: 26, pitchSweepMs: 22, attackMs: 10, sustainSec: 0.38, decaySec: 0.65, h2: 0.2, h3: 0.05, drive: 1.18, lowpassHz: 560 },
  },
  {
    file: '808_melodico_sustentado.wav',
    cfg: { durationSec: 1.85, rootHz: A1, pitchSweepHz: 24, pitchSweepMs: 24, attackMs: 11, sustainSec: 0.6, decaySec: 0.64, h2: 0.24, h3: 0.07, drive: 1.28, lowpassHz: 640 },
  },
  {
    file: '808_suave_melodico.wav',
    cfg: { durationSec: 1.35, rootHz: C2, pitchSweepHz: 22, pitchSweepMs: 25, attackMs: 14, sustainSec: 0.25, decaySec: 0.55, h2: 0.14, h3: 0.02, drive: 1.08, lowpassHz: 420 },
  },
  {
    file: '808_trap_emocional.wav',
    cfg: { durationSec: 1.9, rootHz: A1, pitchSweepHz: 30, pitchSweepMs: 26, attackMs: 12, sustainSec: 0.55, decaySec: 0.72, h2: 0.18, h3: 0.04, drive: 1.2, lowpassHz: 490 },
  },
  {
    file: '808_pierre_bounce_clean.wav',
    cfg: { durationSec: 0.96, rootHz: C2, pitchSweepHz: 58, pitchSweepMs: 16, attackMs: 4.5, sustainSec: 0.12, decaySec: 0.36, h2: 0.18, h3: 0.04, drive: 1.24, lowpassHz: 620 },
  },
  {
    file: '808_rnb_silk_sub.wav',
    cfg: { durationSec: 1.52, rootHz: G1, pitchSweepHz: 18, pitchSweepMs: 26, attackMs: 15, sustainSec: 0.42, decaySec: 0.56, h2: 0.15, h3: 0.03, drive: 1.12, warmDetune: 0.0014, lowpassHz: 460 },
  },

  // === PACK 4: CURTOS, SECOS & TRAP NAO MELODICO (8) ===
  {
    file: '808_nao_melodico_perc.wav',
    cfg: { durationSec: 0.46, rootHz: A1, pitchSweepHz: 175, pitchSweepMs: 14, attackMs: 1.5, sustainSec: 0, decaySec: 0.14, h2: 0.25, h3: 0.1, drive: 1.85, transientKnock: 0.52, lowpassHz: 1350 },
  },
  {
    file: '808_nao_melodico_sub_hit.wav',
    cfg: { durationSec: 0.54, rootHz: C2, pitchSweepHz: 145, pitchSweepMs: 13, attackMs: 1.8, sustainSec: 0, decaySec: 0.18, h2: 0.18, h3: 0.08, drive: 1.72, transientKnock: 0.44, lowpassHz: 960 },
  },
  {
    file: '808_nao_melodico_industrial.wav',
    cfg: { durationSec: 0.58, rootHz: G1, pitchSweepHz: 185, pitchSweepMs: 14, attackMs: 1.2, sustainSec: 0.02, decaySec: 0.19, h2: 0.33, h3: 0.18, drive: 2.55, transientKnock: 0.64, transientFreq: 195, lowpassHz: 1550 },
  },
  {
    file: '808_curto_seco.wav',
    cfg: { durationSec: 0.34, rootHz: C2, pitchSweepHz: 155, pitchSweepMs: 11, attackMs: 1.5, sustainSec: 0, decaySec: 0.095, h2: 0.22, h3: 0.08, drive: 1.6, transientKnock: 0.35, lowpassHz: 1200 },
  },
  {
    file: '808_curto_staccato.wav',
    cfg: { durationSec: 0.39, rootHz: C2, pitchSweepHz: 125, pitchSweepMs: 12, attackMs: 2, sustainSec: 0, decaySec: 0.115, h2: 0.3, h3: 0.12, drive: 2.05, transientKnock: 0.42, lowpassHz: 1420 },
  },
  {
    file: '808_curto_tight_sub.wav',
    cfg: { durationSec: 0.48, rootHz: C2, pitchSweepHz: 85, pitchSweepMs: 14, attackMs: 2.5, sustainSec: 0, decaySec: 0.155, h2: 0.15, h3: 0.04, drive: 1.35, transientKnock: 0.28, lowpassHz: 740 },
  },
  {
    file: '808_micro_punch_280.wav',
    cfg: { durationSec: 0.28, rootHz: C2, pitchSweepHz: 185, pitchSweepMs: 10, attackMs: 1.0, sustainSec: 0, decaySec: 0.075, h2: 0.28, h3: 0.12, drive: 1.92, transientKnock: 0.56, transientFreq: 215, lowpassHz: 1480 },
  },
  {
    file: '808_dry_street_thump.wav',
    cfg: { durationSec: 0.62, rootHz: As1, pitchSweepHz: 135, pitchSweepMs: 13, attackMs: 1.8, sustainSec: 0.02, decaySec: 0.21, h2: 0.29, h3: 0.13, drive: 2.0, transientKnock: 0.46, transientFreq: 180, lowpassHz: 1180 },
  },

  // === PACK 5: LONGOS & PROFUNDOS (7) ===
  {
    file: '808_longo_profundo.wav',
    cfg: { durationSec: 2.5, rootHz: G1, pitchSweepHz: 55, pitchSweepMs: 24, attackMs: 6, sustainSec: 1.25, decaySec: 0.62, h2: 0.22, h3: 0.07, drive: 1.4, lowpassHz: 540 },
  },
  {
    file: '808_longo_sub_subterraneo.wav',
    cfg: { durationSec: 2.35, rootHz: F1, pitchSweepHz: 48, pitchSweepMs: 26, attackMs: 7, sustainSec: 1.1, decaySec: 0.6, h2: 0.26, h3: 0.09, drive: 1.52, lowpassHz: 480, highpassHz: 25 },
  },
  {
    file: '808_longo_atl_sustain.wav',
    cfg: { durationSec: 2.1, rootHz: C2, pitchSweepHz: 88, pitchSweepMs: 18, attackMs: 3.5, sustainSec: 0.88, decaySec: 0.58, h2: 0.27, h3: 0.1, drive: 1.68, transientKnock: 0.24, lowpassHz: 960 },
  },
  {
    file: '808_profundo_velvet.wav',
    cfg: { durationSec: 1.75, rootHz: A1, pitchSweepHz: 40, pitchSweepMs: 22, attackMs: 8, sustainSec: 0.62, decaySec: 0.58, h2: 0.19, h3: 0.05, drive: 1.32, lowpassHz: 520 },
  },
  {
    file: '808_sub_atmosferico_fs1.wav',
    cfg: { durationSec: 2.4, rootHz: Fs1, pitchSweepHz: 52, pitchSweepMs: 25, attackMs: 8.5, sustainSec: 1.15, decaySec: 0.64, h2: 0.21, h3: 0.06, drive: 1.36, warmDetune: 0.0012, lowpassHz: 510, highpassHz: 25 },
  },
  {
    file: '808_deep_trunk_shaker.wav',
    cfg: { durationSec: 2.05, rootHz: Gs1, pitchSweepHz: 110, pitchSweepMs: 19, attackMs: 3.2, sustainSec: 0.84, decaySec: 0.6, h2: 0.31, h3: 0.13, drive: 1.98, transientKnock: 0.32, lowpassHz: 880 },
  },
  {
    file: '808_ultra_sub_limpo.wav',
    cfg: { durationSec: 2.2, rootHz: G1, pitchSweepHz: 28, pitchSweepMs: 28, attackMs: 10, sustainSec: 0.98, decaySec: 0.62, h2: 0.11, h3: 0.02, drive: 1.08, lowpassHz: 390 },
  },

  // === PACK 6: DRILL, SLIDES & GLIDES (8) ===
  {
    file: '808_slide_glide_pro.wav',
    cfg: {
      durationSec: 1.4,
      rootHz: C2,
      pitchSweepHz: 65,
      pitchSweepMs: 15,
      attackMs: 3,
      sustainSec: 0.3,
      decaySec: 0.52,
      h2: 0.3,
      h3: 0.12,
      drive: 1.9,
      lowpassHz: 1250,
      pitchCurveFn: (t, base) => {
        if (t < 0.24) return base;
        if (t < 0.56) {
          const u = (t - 0.24) / 0.32;
          return C2 * Math.pow(2, (7 * u) / 12);
        }
        if (t < 0.92) {
          const u = (t - 0.56) / 0.36;
          return C2 * Math.pow(2, (7 * (1 - u)) / 12);
        }
        return C2;
      },
    },
  },
  {
    file: '808_drill_uk.wav',
    cfg: {
      durationSec: 1.32,
      rootHz: C2,
      pitchSweepHz: 95,
      pitchSweepMs: 15,
      attackMs: 2.5,
      sustainSec: 0.22,
      decaySec: 0.5,
      h2: 0.32,
      h3: 0.15,
      drive: 2.2,
      lowpassHz: 1450,
      pitchCurveFn: (t, base) => {
        if (t < 0.18) return base;
        if (t < 0.44) {
          const u = (t - 0.18) / 0.26;
          return C2 * Math.pow(2, (12 * u) / 12);
        }
        if (t < 0.78) {
          const u = (t - 0.44) / 0.34;
          return C2 * Math.pow(2, (12 - 7 * u) / 12);
        }
        return C2 * Math.pow(2, 5 / 12);
      },
    },
  },
  {
    file: '808_glide_descendente.wav',
    cfg: {
      durationSec: 1.0,
      rootHz: C2,
      pitchSweepHz: 40,
      pitchSweepMs: 14,
      attackMs: 3,
      sustainSec: 0.12,
      decaySec: 0.42,
      h2: 0.28,
      h3: 0.12,
      drive: 1.75,
      lowpassHz: 1100,
      pitchCurveFn: (t) => {
        if (t < 0.22) {
          const u = t / 0.22;
          return C2 * 2 * Math.pow(0.5, u);
        }
        return C2;
      },
    },
  },
  {
    file: '808_slide_duplo_drill.wav',
    cfg: {
      durationSec: 1.48,
      rootHz: C2,
      pitchSweepHz: 70,
      pitchSweepMs: 15,
      attackMs: 2.5,
      sustainSec: 0.36,
      decaySec: 0.5,
      h2: 0.31,
      h3: 0.14,
      drive: 2.05,
      lowpassHz: 1380,
      pitchCurveFn: (t, base) => {
        if (t < 0.16) return base;
        if (t < 0.34) {
          const u = (t - 0.16) / 0.18;
          return C2 * Math.pow(2, (3 * u) / 12);
        }
        if (t < 0.62) {
          const u = (t - 0.34) / 0.28;
          return C2 * Math.pow(2, (3 + 9 * u) / 12);
        }
        if (t < 0.96) {
          const u = (t - 0.62) / 0.34;
          return C2 * Math.pow(2, (12 * (1 - u)) / 12);
        }
        return C2;
      },
    },
  },
  {
    file: '808_ny_drill_punch_slide.wav',
    cfg: {
      durationSec: 1.18,
      rootHz: A1,
      pitchSweepHz: 125,
      pitchSweepMs: 13,
      attackMs: 1.5,
      sustainSec: 0.2,
      decaySec: 0.46,
      h2: 0.36,
      h3: 0.18,
      drive: 2.5,
      transientKnock: 0.48,
      lowpassHz: 1620,
      pitchCurveFn: (t, base) => {
        if (t < 0.14) return base;
        if (t < 0.36) {
          const u = (t - 0.14) / 0.22;
          return A1 * Math.pow(2, (12 * u) / 12);
        }
        return A1 * 2;
      },
    },
  },
  {
    file: '808_terca_menor_glide.wav',
    cfg: {
      durationSec: 1.24,
      rootHz: C2,
      pitchSweepHz: 60,
      pitchSweepMs: 16,
      attackMs: 3.5,
      sustainSec: 0.22,
      decaySec: 0.48,
      h2: 0.24,
      h3: 0.08,
      drive: 1.68,
      lowpassHz: 1080,
      pitchCurveFn: (t, base) => {
        if (t < 0.2) return base;
        if (t < 0.48) {
          const u = (t - 0.2) / 0.28;
          return C2 * Math.pow(2, (3 * u) / 12);
        }
        return C2 * Math.pow(2, 3 / 12);
      },
    },
  },
  {
    file: '808_drop_sub_fs1.wav',
    cfg: {
      durationSec: 1.38,
      rootHz: Fs1,
      pitchSweepHz: 70,
      pitchSweepMs: 15,
      attackMs: 2.2,
      sustainSec: 0.28,
      decaySec: 0.5,
      h2: 0.3,
      h3: 0.13,
      drive: 2.1,
      lowpassHz: 1200,
      highpassHz: 25,
      pitchCurveFn: (t) => {
        if (t < 0.28) {
          const u = t / 0.28;
          return Fs1 * 2 * Math.pow(0.5, u);
        }
        return Fs1;
      },
    },
  },
  {
    file: '808_uk_melodic_glide.wav',
    cfg: {
      durationSec: 1.5,
      rootHz: A1,
      pitchSweepHz: 45,
      pitchSweepMs: 18,
      attackMs: 5,
      sustainSec: 0.34,
      decaySec: 0.55,
      h2: 0.26,
      h3: 0.09,
      drive: 1.55,
      lowpassHz: 940,
      pitchCurveFn: (t, base) => {
        if (t < 0.25) return base;
        if (t < 0.58) {
          const u = (t - 0.25) / 0.33;
          return A1 * Math.pow(2, (7 * u) / 12);
        }
        if (t < 0.95) {
          const u = (t - 0.58) / 0.37;
          return A1 * Math.pow(2, (7 - 4 * u) / 12);
        }
        return A1 * Math.pow(2, 3 / 12);
      },
    },
  },

  // === PACK 7: RAGE TRAP & OPIUM (6) ===
  {
    file: '808_rage_trap.wav',
    cfg: { durationSec: 1.18, rootHz: C2, pitchSweepHz: 140, pitchSweepMs: 14, attackMs: 2, sustainSec: 0.28, decaySec: 0.42, h2: 0.46, h3: 0.34, drive: 4.8, asymmetry: 0.9, lowpassHz: 2900 },
  },
  {
    file: '808_rage_overdrive.wav',
    cfg: { durationSec: 1.28, rootHz: A1, pitchSweepHz: 150, pitchSweepMs: 15, attackMs: 1.8, sustainSec: 0.35, decaySec: 0.45, h2: 0.5, h3: 0.36, h4: 0.18, drive: 5.2, asymmetry: 1.3, transientKnock: 0.32, lowpassHz: 3100 },
  },
  {
    file: '808_opium_buzz_sub.wav',
    cfg: { durationSec: 1.14, rootHz: G1, pitchSweepHz: 135, pitchSweepMs: 15, attackMs: 1.5, sustainSec: 0.32, decaySec: 0.4, h2: 0.54, h3: 0.4, h4: 0.22, h5: 0.12, drive: 5.4, asymmetry: 1.2, warmDetune: 0.0022, lowpassHz: 3300 },
  },
  {
    file: '808_rage_industrial_crunch.wav',
    cfg: { durationSec: 0.92, rootHz: C2, pitchSweepHz: 165, pitchSweepMs: 12, attackMs: 1.2, sustainSec: 0.18, decaySec: 0.34, h2: 0.48, h3: 0.34, h4: 0.2, drive: 4.9, asymmetry: 1.6, transientKnock: 0.45, lowpassHz: 2950 },
  },
  {
    file: '808_hyper_trap_saturado.wav',
    cfg: { durationSec: 1.04, rootHz: D2, pitchSweepHz: 120, pitchSweepMs: 14, attackMs: 1.6, sustainSec: 0.24, decaySec: 0.38, h2: 0.44, h3: 0.3, h4: 0.16, drive: 4.2, asymmetry: 0.8, lowpassHz: 2700 },
  },
  {
    file: '808_synth_distortion_rage.wav',
    cfg: { durationSec: 1.36, rootHz: A1, pitchSweepHz: 95, pitchSweepMs: 18, attackMs: 2.5, sustainSec: 0.46, decaySec: 0.44, h2: 0.5, h3: 0.38, h4: 0.24, drive: 4.5, warmDetune: 0.003, lowpassHz: 3000 },
  },

  // === PACK 8: DARK TRAP & MEMPHIS (7) ===
  {
    file: '808_dark_trap.wav',
    cfg: { durationSec: 1.55, rootHz: G1, pitchSweepHz: 85, pitchSweepMs: 20, attackMs: 4, sustainSec: 0.34, decaySec: 0.58, h2: 0.26, h3: 0.14, drive: 1.8, lowpassHz: 780 },
  },
  {
    file: '808_dark_shadow_sub.wav',
    cfg: { durationSec: 1.42, rootHz: A1, pitchSweepHz: 95, pitchSweepMs: 18, attackMs: 3.5, sustainSec: 0.26, decaySec: 0.54, h2: 0.29, h3: 0.15, drive: 2.1, transientKnock: 0.34, lowpassHz: 860 },
  },
  {
    file: '808_memphis_phonk_sub.wav',
    cfg: { durationSec: 1.15, rootHz: F1, pitchSweepHz: 130, pitchSweepMs: 16, attackMs: 2, sustainSec: 0.2, decaySec: 0.44, h2: 0.38, h3: 0.24, drive: 3.3, asymmetry: 0.9, transientKnock: 0.42, lowpassHz: 1450, highpassHz: 25 },
  },
  {
    file: '808_dark_sub_baixo_f1.wav',
    cfg: { durationSec: 1.72, rootHz: F1, pitchSweepHz: 68, pitchSweepMs: 22, attackMs: 5, sustainSec: 0.5, decaySec: 0.6, h2: 0.24, h3: 0.12, drive: 1.75, lowpassHz: 650, highpassHz: 25 },
  },
  {
    file: '808_sombrio_distorcido.wav',
    cfg: { durationSec: 1.24, rootHz: G1, pitchSweepHz: 112, pitchSweepMs: 17, attackMs: 2.8, sustainSec: 0.22, decaySec: 0.48, h2: 0.36, h3: 0.22, drive: 3.1, asymmetry: 0.65, lowpassHz: 1120 },
  },
  {
    file: '808_shadow_bell_sub.wav',
    cfg: { durationSec: 1.48, rootHz: Gs1, pitchSweepHz: 78, pitchSweepMs: 19, attackMs: 4.5, sustainSec: 0.3, decaySec: 0.56, h2: 0.28, h3: 0.11, drive: 1.9, warmDetune: 0.0016, lowpassHz: 820 },
  },
  {
    file: '808_horror_trap_deep.wav',
    cfg: { durationSec: 1.65, rootHz: Fs1, pitchSweepHz: 105, pitchSweepMs: 20, attackMs: 3.5, sustainSec: 0.42, decaySec: 0.58, h2: 0.32, h3: 0.18, drive: 2.4, transientKnock: 0.36, lowpassHz: 940, highpassHz: 25 },
  },

  // === PACK 9: TRAP EMOCIONAL, AFRO-TRAP & EURO (6) ===
  {
    file: '808_emocional_quente_c2.wav',
    cfg: { durationSec: 1.62, rootHz: C2, pitchSweepHz: 32, pitchSweepMs: 24, attackMs: 11, sustainSec: 0.4, decaySec: 0.62, h2: 0.2, h3: 0.05, drive: 1.25, warmDetune: 0.0015, lowpassHz: 540 },
  },
  {
    file: '808_afro_trap_bounce.wav',
    cfg: { durationSec: 0.78, rootHz: C2, pitchSweepHz: 88, pitchSweepMs: 15, attackMs: 3.5, sustainSec: 0.06, decaySec: 0.28, h2: 0.23, h3: 0.07, drive: 1.45, transientKnock: 0.26, lowpassHz: 890 },
  },
  {
    file: '808_sad_guitar_clean.wav',
    cfg: { durationSec: 1.78, rootHz: G1, pitchSweepHz: 24, pitchSweepMs: 25, attackMs: 13, sustainSec: 0.52, decaySec: 0.64, h2: 0.16, h3: 0.04, drive: 1.16, lowpassHz: 470 },
  },
  {
    file: '808_euro_drill_warm.wav',
    cfg: { durationSec: 1.28, rootHz: A1, pitchSweepHz: 72, pitchSweepMs: 18, attackMs: 4, sustainSec: 0.22, decaySec: 0.5, h2: 0.28, h3: 0.1, drive: 1.72, lowpassHz: 950 },
  },
  {
    file: '808_trap_acustico_redondo.wav',
    cfg: { durationSec: 1.32, rootHz: As1, pitchSweepHz: 38, pitchSweepMs: 22, attackMs: 9.5, sustainSec: 0.26, decaySec: 0.52, h2: 0.18, h3: 0.04, drive: 1.22, lowpassHz: 520 },
  },
  {
    file: '808_late_night_sub.wav',
    cfg: { durationSec: 1.88, rootHz: G1, pitchSweepHz: 30, pitchSweepMs: 26, attackMs: 12, sustainSec: 0.64, decaySec: 0.65, h2: 0.21, h3: 0.06, drive: 1.32, warmDetune: 0.0014, lowpassHz: 510 },
  },

  // === PACK 10: GRANDE IMPACTO FRONTAL & ATAQUE (4) ===
  {
    file: '808_front_kick_hybrid.wav',
    cfg: { durationSec: 0.94, rootHz: C2, pitchSweepHz: 225, pitchSweepMs: 11, attackMs: 1, sustainSec: 0.05, decaySec: 0.36, h2: 0.3, h3: 0.13, drive: 2.05, transientKnock: 0.78, transientFreq: 205, lowpassHz: 1950 },
  },
  {
    file: '808_brickwall_punch.wav',
    cfg: { durationSec: 1.16, rootHz: A1, pitchSweepHz: 185, pitchSweepMs: 12, attackMs: 1.2, sustainSec: 0.14, decaySec: 0.42, h2: 0.38, h3: 0.2, drive: 3.15, transientKnock: 0.68, transientFreq: 180, lowpassHz: 1750 },
  },
  {
    file: '808_sharp_click_transient.wav',
    cfg: { durationSec: 0.84, rootHz: C2, pitchSweepHz: 240, pitchSweepMs: 9, attackMs: 0.8, sustainSec: 0.04, decaySec: 0.3, h2: 0.26, h3: 0.12, drive: 1.88, transientKnock: 0.82, transientFreq: 240, lowpassHz: 2100 },
  },
  {
    file: '808_chest_slap_808.wav',
    cfg: { durationSec: 1.26, rootHz: G1, pitchSweepHz: 190, pitchSweepMs: 13, attackMs: 1.3, sustainSec: 0.16, decaySec: 0.48, h2: 0.33, h3: 0.16, drive: 2.35, transientKnock: 0.64, transientFreq: 168, lowpassHz: 1580 },
  },
];

const report = specs.map((s) => writeWav(s.file, buildTrap808(s.cfg)));
console.table(report);

const hashes = new Set(report.map((r) => r.hash));
if (hashes.size !== report.length) {
  throw new Error('Duplicate WAV hash detected!');
}
console.log(`Generated ${report.length} unique modern TRAP 808 WAV files in ${OUT_DIR}`);
