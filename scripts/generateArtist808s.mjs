import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT_DIR = path.resolve('public/audio/808');
fs.mkdirSync(OUT_DIR, { recursive: true });

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

function buildArtist808({
  durationSec,
  rootHz = 65.406,
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
  highpassHz = 26,
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
  // 1. Juice WRLD
  {
    file: '808_artist_juice_lucid.wav',
    cfg: { durationSec: 1.72, rootHz: C2, pitchSweepHz: 28, pitchSweepMs: 25, attackMs: 12, sustainSec: 0.48, decaySec: 0.62, h2: 0.16, h3: 0.04, drive: 1.15, warmDetune: 0.0011, lowpassHz: 480 },
  },
  {
    file: '808_artist_juice_robbery.wav',
    cfg: { durationSec: 1.96, rootHz: A1, pitchSweepHz: 46, pitchSweepMs: 22, attackMs: 8.5, sustainSec: 0.68, decaySec: 0.64, h2: 0.25, h3: 0.09, drive: 1.48, lowpassHz: 690 },
  },
  // 2. NBA YoungBoy
  {
    file: '808_artist_yb_outside.wav',
    cfg: { durationSec: 1.28, rootHz: C2, pitchSweepHz: 195, pitchSweepMs: 12, attackMs: 1.2, sustainSec: 0.14, decaySec: 0.46, h2: 0.36, h3: 0.18, h4: 0.06, drive: 2.55, transientKnock: 0.66, transientFreq: 192, lowpassHz: 1620 },
  },
  {
    file: '808_artist_yb_bandit.wav',
    cfg: { durationSec: 0.86, rootHz: As1, pitchSweepHz: 165, pitchSweepMs: 13, attackMs: 1.3, sustainSec: 0.08, decaySec: 0.32, h2: 0.43, h3: 0.26, h4: 0.1, drive: 3.65, asymmetry: 0.85, transientKnock: 0.54, transientFreq: 185, lowpassHz: 2150 },
  },
  // 3. Lil Uzi Vert
  {
    file: '808_artist_uzi_xo.wav',
    cfg: { durationSec: 1.56, rootHz: G1, pitchSweepHz: 78, pitchSweepMs: 20, attackMs: 4.2, sustainSec: 0.42, decaySec: 0.56, h2: 0.28, h3: 0.14, drive: 1.98, warmDetune: 0.0017, lowpassHz: 840 },
  },
  {
    file: '808_artist_uzi_wanna.wav',
    cfg: { durationSec: 0.52, rootHz: D2, pitchSweepHz: 185, pitchSweepMs: 10, attackMs: 1.1, sustainSec: 0.02, decaySec: 0.17, h2: 0.3, h3: 0.12, drive: 2.15, transientKnock: 0.58, transientFreq: 215, lowpassHz: 1580 },
  },
  // 4. Future
  {
    file: '808_artist_future_mask.wav',
    cfg: { durationSec: 1.24, rootHz: A1, pitchSweepHz: 52, pitchSweepMs: 19, attackMs: 6.5, sustainSec: 0.24, decaySec: 0.48, h2: 0.15, h3: 0.04, drive: 1.22, lowpassHz: 540 },
  },
  {
    file: '808_artist_future_march.wav',
    cfg: { durationSec: 1.62, rootHz: F1, pitchSweepHz: 138, pitchSweepMs: 17, attackMs: 1.8, sustainSec: 0.36, decaySec: 0.58, h2: 0.33, h3: 0.17, drive: 2.45, transientKnock: 0.48, transientFreq: 162, lowpassHz: 1120, highpassHz: 24 },
  },
  // 5. Playboi Carti
  {
    file: '808_artist_carti_magnolia.wav',
    cfg: { durationSec: 0.82, rootHz: C2, pitchSweepHz: 68, pitchSweepMs: 15, attackMs: 3.2, sustainSec: 0.08, decaySec: 0.30, h2: 0.19, h3: 0.05, drive: 1.28, transientKnock: 0.22, lowpassHz: 680 },
  },
  {
    file: '808_artist_carti_sky.wav',
    cfg: { durationSec: 1.18, rootHz: Gs1, pitchSweepHz: 148, pitchSweepMs: 14, attackMs: 1.5, sustainSec: 0.34, decaySec: 0.40, h2: 0.55, h3: 0.42, h4: 0.24, h5: 0.13, drive: 5.6, asymmetry: 1.45, warmDetune: 0.0024, lowpassHz: 3450 },
  },
  // 6. Travis Scott
  {
    file: '808_artist_travis_goosebumps.wav',
    cfg: { durationSec: 1.86, rootHz: Fs1, pitchSweepHz: 64, pitchSweepMs: 22, attackMs: 5.5, sustainSec: 0.62, decaySec: 0.62, h2: 0.27, h3: 0.11, drive: 1.72, warmDetune: 0.0021, lowpassHz: 790, highpassHz: 24 },
  },
  {
    file: '808_artist_travis_sicko.wav',
    cfg: { durationSec: 1.34, rootHz: C2, pitchSweepHz: 172, pitchSweepMs: 14, attackMs: 1.4, sustainSec: 0.22, decaySec: 0.48, h2: 0.41, h3: 0.25, h4: 0.11, drive: 3.45, asymmetry: 0.78, transientKnock: 0.55, transientFreq: 182, lowpassHz: 1920 },
  },
  // 7. Chief Keef
  {
    file: '808_artist_keef_sosa.wav',
    cfg: { durationSec: 1.38, rootHz: C2, pitchSweepHz: 162, pitchSweepMs: 15, attackMs: 1.5, sustainSec: 0.25, decaySec: 0.50, h2: 0.38, h3: 0.21, drive: 2.85, transientKnock: 0.6, transientFreq: 174, lowpassHz: 1480 },
  },
  {
    file: '808_artist_keef_faneto.wav',
    cfg: { durationSec: 1.46, rootHz: G1, pitchSweepHz: 136, pitchSweepMs: 16, attackMs: 1.8, sustainSec: 0.32, decaySec: 0.50, h2: 0.53, h3: 0.38, h4: 0.21, h5: 0.11, drive: 5.3, asymmetry: 1.65, lowpassHz: 3050 },
  },
  // 8. Lil Baby
  {
    file: '808_artist_baby_drip.wav',
    cfg: { durationSec: 1.04, rootHz: C2, pitchSweepHz: 92, pitchSweepMs: 16, attackMs: 2.6, sustainSec: 0.12, decaySec: 0.40, h2: 0.23, h3: 0.07, drive: 1.42, transientKnock: 0.28, lowpassHz: 940 },
  },
  {
    file: '808_artist_baby_freestyle.wav',
    cfg: { durationSec: 0.94, rootHz: As1, pitchSweepHz: 168, pitchSweepMs: 12, attackMs: 1.2, sustainSec: 0.06, decaySec: 0.35, h2: 0.37, h3: 0.19, drive: 2.65, transientKnock: 0.62, transientFreq: 198, lowpassHz: 1680 },
  },
  // 9. Gunna
  {
    file: '808_artist_gunna_fukumean.wav',
    cfg: { durationSec: 1.42, rootHz: G1, pitchSweepHz: 56, pitchSweepMs: 20, attackMs: 5.2, sustainSec: 0.34, decaySec: 0.52, h2: 0.18, h3: 0.05, drive: 1.32, lowpassHz: 580 },
  },
  {
    file: '808_artist_gunna_pushin.wav',
    cfg: { durationSec: 1.12, rootHz: C2, pitchSweepHz: 38, pitchSweepMs: 22, attackMs: 7.5, sustainSec: 0.18, decaySec: 0.44, h2: 0.14, h3: 0.03, drive: 1.12, warmDetune: 0.0012, lowpassHz: 460 },
  },
  // 10. Young Thug
  {
    file: '808_artist_thug_hot.wav',
    cfg: { durationSec: 1.22, rootHz: C2, pitchSweepHz: 148, pitchSweepMs: 13, attackMs: 1.5, sustainSec: 0.16, decaySec: 0.44, h2: 0.33, h3: 0.15, drive: 2.22, transientKnock: 0.52, transientFreq: 190, lowpassHz: 1440 },
  },
  {
    file: '808_artist_thug_digits.wav',
    cfg: {
      durationSec: 1.36,
      rootHz: A1,
      pitchSweepHz: 75,
      pitchSweepMs: 15,
      attackMs: 3.2,
      sustainSec: 0.30,
      decaySec: 0.48,
      h2: 0.27,
      h3: 0.10,
      drive: 1.78,
      lowpassHz: 1180,
      pitchCurveFn: (t, base) => {
        if (t < 0.20) return base;
        if (t < 0.48) {
          const u = (t - 0.20) / 0.28;
          return A1 * Math.pow(2, (7 * u) / 12);
        }
        if (t < 0.84) {
          const u = (t - 0.48) / 0.36;
          return A1 * Math.pow(2, (7 * (1 - u)) / 12);
        }
        return A1;
      },
    },
  },
  // 11. 21 Savage
  {
    file: '808_artist_21_bank.wav',
    cfg: { durationSec: 1.74, rootHz: F1, pitchSweepHz: 54, pitchSweepMs: 24, attackMs: 5.8, sustainSec: 0.54, decaySec: 0.58, h2: 0.17, h3: 0.06, drive: 1.44, lowpassHz: 520, highpassHz: 24 },
  },
  {
    file: '808_artist_21_alot.wav',
    cfg: { durationSec: 1.30, rootHz: G1, pitchSweepHz: 122, pitchSweepMs: 16, attackMs: 2.2, sustainSec: 0.22, decaySec: 0.50, h2: 0.31, h3: 0.16, drive: 2.38, transientKnock: 0.40, transientFreq: 168, lowpassHz: 1020 },
  },
  // 12. Yeat
  {
    file: '808_artist_yeat_money.wav',
    cfg: { durationSec: 1.26, rootHz: A1, pitchSweepHz: 155, pitchSweepMs: 14, attackMs: 1.4, sustainSec: 0.34, decaySec: 0.42, h2: 0.51, h3: 0.37, h4: 0.22, h5: 0.10, drive: 5.15, asymmetry: 1.25, warmDetune: 0.0028, lowpassHz: 3250 },
  },
  {
    file: '808_artist_yeat_flawless.wav',
    cfg: {
      durationSec: 1.18,
      rootHz: C2,
      pitchSweepHz: 135,
      pitchSweepMs: 13,
      attackMs: 1.5,
      sustainSec: 0.28,
      decaySec: 0.42,
      h2: 0.48,
      h3: 0.34,
      h4: 0.18,
      drive: 4.55,
      asymmetry: 1.1,
      lowpassHz: 2850,
      pitchCurveFn: (t, base) => {
        if (t < 0.16) return base;
        if (t < 0.36) {
          const u = (t - 0.16) / 0.20;
          return C2 * Math.pow(2, (12 * u) / 12);
        }
        return C2 * 2;
      },
    },
  },
  // 13. Don Toliver
  {
    file: '808_artist_toliver_noidea.wav',
    cfg: { durationSec: 1.82, rootHz: Fs1, pitchSweepHz: 34, pitchSweepMs: 25, attackMs: 11.5, sustainSec: 0.58, decaySec: 0.62, h2: 0.19, h3: 0.06, drive: 1.30, warmDetune: 0.0019, lowpassHz: 560, highpassHz: 24 },
  },
  {
    file: '808_artist_toliver_afterparty.wav',
    cfg: { durationSec: 1.44, rootHz: A1, pitchSweepHz: 62, pitchSweepMs: 18, attackMs: 4.8, sustainSec: 0.32, decaySec: 0.54, h2: 0.22, h3: 0.07, drive: 1.46, lowpassHz: 720 },
  },
  // 14. XXXTentacion
  {
    file: '808_artist_x_lookatme.wav',
    cfg: { durationSec: 1.14, rootHz: G1, pitchSweepHz: 142, pitchSweepMs: 15, attackMs: 1.2, sustainSec: 0.36, decaySec: 0.38, h2: 0.58, h3: 0.45, h4: 0.28, h5: 0.16, drive: 6.4, asymmetry: 1.85, transientKnock: 0.46, lowpassHz: 3600 },
  },
  {
    file: '808_artist_x_jocelyn.wav',
    cfg: { durationSec: 1.68, rootHz: A1, pitchSweepHz: 20, pitchSweepMs: 27, attackMs: 14.5, sustainSec: 0.46, decaySec: 0.60, h2: 0.13, h3: 0.02, drive: 1.09, lowpassHz: 410 },
  },
  // 15. Polo G
  {
    file: '808_artist_polog_rapstar.wav',
    cfg: { durationSec: 1.38, rootHz: C2, pitchSweepHz: 72, pitchSweepMs: 17, attackMs: 4.2, sustainSec: 0.24, decaySec: 0.52, h2: 0.21, h3: 0.06, drive: 1.38, lowpassHz: 660 },
  },
  {
    file: '808_artist_polog_popout.wav',
    cfg: {
      durationSec: 1.25,
      rootHz: As1,
      pitchSweepHz: 155,
      pitchSweepMs: 13,
      attackMs: 1.4,
      sustainSec: 0.18,
      decaySec: 0.46,
      h2: 0.34,
      h3: 0.16,
      drive: 2.38,
      transientKnock: 0.56,
      transientFreq: 188,
      lowpassHz: 1480,
      pitchCurveFn: (t, base) => {
        if (t < 0.28) return base;
        if (t < 0.54) {
          const u = (t - 0.28) / 0.26;
          return As1 * Math.pow(2, (3 * u) / 12);
        }
        return As1 * Math.pow(2, 3 / 12);
      },
    },
  },
  // 16. Trippie Redd
  {
    file: '808_artist_trippie_miss.wav',
    cfg: { durationSec: 1.40, rootHz: C2, pitchSweepHz: 150, pitchSweepMs: 14, attackMs: 1.6, sustainSec: 0.32, decaySec: 0.48, h2: 0.47, h3: 0.33, h4: 0.16, drive: 4.35, asymmetry: 0.95, warmDetune: 0.0023, transientKnock: 0.44, lowpassHz: 2780 },
  },
  {
    file: '808_artist_trippie_dark.wav',
    cfg: {
      durationSec: 1.54,
      rootHz: G1,
      pitchSweepHz: 88,
      pitchSweepMs: 18,
      attackMs: 2.8,
      sustainSec: 0.40,
      decaySec: 0.54,
      h2: 0.31,
      h3: 0.14,
      drive: 2.25,
      lowpassHz: 1120,
      pitchCurveFn: (t, base) => {
        if (t < 0.22) return base;
        if (t < 0.46) {
          const u = (t - 0.22) / 0.24;
          return G1 * Math.pow(2, (5 * u) / 12);
        }
        if (t < 0.82) {
          const u = (t - 0.46) / 0.36;
          return G1 * Math.pow(2, (5 * (1 - u)) / 12);
        }
        return G1;
      },
    },
  },
];

// Record pre-existing WAV hashes to assert zero modification or deletion
const existingBefore = new Map();
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith('.wav') && !f.startsWith('808_artist_')) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT_DIR, f))).digest('hex');
    existingBefore.set(f, h);
  }
}

const report = specs.map((s) => writeWav(s.file, buildArtist808(s.cfg)));
console.table(report);

// Verify all WAVs in directory (existing + new) are intact and 100% unique
const allHashes = new Set();
const allWavs = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.wav'));
for (const f of allWavs) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT_DIR, f))).digest('hex');
  if (existingBefore.has(f) && existingBefore.get(f) !== h) {
    throw new Error(`Existing WAV altered unexpectedly: ${f}`);
  }
  if (allHashes.has(h)) {
    throw new Error(`Duplicate WAV hash detected for: ${f}`);
  }
  allHashes.add(h);
}

console.log(`Preserved ${existingBefore.size} existing WAVs intact + generated ${report.length} new artist WAVs = ${allWavs.length} unique WAV files.`);
