import {
  BeatPattern,
  BeatStep,
  BeatTrackId,
  MusicalKey,
  MusicalScale,
} from '../types/studio';

export const CURRENT_PATTERN_VERSION = 2;

export type TrapStylePresetId =
  | 'trap_americano'
  | 'dark_trap'
  | 'rage_trap'
  | 'trap_melodico'
  | 'drill_uk'
  | 'nao_melodico';

export interface TrapStylePresetMeta {
  id: TrapStylePresetId;
  label: string;
  descriptionPt: string;
  defaultBpm: number;
  allowMelodies: boolean;
}

export const TRAP_STYLE_PRESETS: TrapStylePresetMeta[] = [
  {
    id: 'trap_americano',
    label: 'Trap Americano',
    descriptionPt: 'Base comercial de Atlanta em 4 compassos: 808 encorpado, snare half-time firme e hi-hats limpos.',
    defaultBpm: 140,
    allowMelodies: true,
  },
  {
    id: 'dark_trap',
    label: 'Dark Trap',
    descriptionPt: 'Beat sombrio e pesado em 4 compassos com progressão tensa, sub profundo e espaço para voz grave.',
    defaultBpm: 134,
    allowMelodies: true,
  },
  {
    id: 'rage_trap',
    label: 'Rage Trap',
    descriptionPt: 'Energia alta e direta com 808 agressivo, bateria incisiva e padrão dinâmico de 4 compassos.',
    defaultBpm: 144,
    allowMelodies: true,
  },
  {
    id: 'trap_melodico',
    label: 'Trap Melódico',
    descriptionPt: 'Groove envolvente e suave para cantar com Autotune, com 808 afinado e bell musical.',
    defaultBpm: 130,
    allowMelodies: true,
  },
  {
    id: 'drill_uk',
    label: 'Drill / Slides',
    descriptionPt: 'Padrão sincopado estilo Drill moderno com glides de 808 e bateria bem recortada.',
    defaultBpm: 142,
    allowMelodies: true,
  },
  {
    id: 'nao_melodico',
    label: 'Trap Puro (Sem Melodia)',
    descriptionPt: 'Apenas bateria de impacto, 808 e percussão limpa sem nenhum instrumento melódico.',
    defaultBpm: 138,
    allowMelodies: false,
  },
];

const KEY_TO_SEMITONE: Record<MusicalKey, number> = {
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

const SCALE_INTERVALS: Record<MusicalScale, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

function makeEmptySteps(count: number): BeatStep[] {
  return Array.from({ length: count }, () => ({ active: false, velocity: 0.85 }));
}

export function getScaleDegreeMidi(
  key: MusicalKey | string,
  scale: MusicalScale | string,
  degreeIndex: number,
  baseOctaveMidi: number
): number {
  const rootSemi = KEY_TO_SEMITONE[(key as MusicalKey) || 'C'] ?? 0;
  const intervals = SCALE_INTERVALS[(scale as MusicalScale) || 'minor'] ?? SCALE_INTERVALS.minor;
  const len = intervals.length;
  const octShift = Math.floor(degreeIndex / len);
  const normDeg = ((degreeIndex % len) + len) % len;
  return baseOctaveMidi + rootSemi + intervals[normDeg] + octShift * 12;
}

export function snapMidiToScale(
  midi: number,
  key: MusicalKey | string,
  scale: MusicalScale | string,
  minMidi: number,
  maxMidi: number
): number {
  const rootSemi = KEY_TO_SEMITONE[(key as MusicalKey) || 'C'] ?? 0;
  const intervals = SCALE_INTERVALS[(scale as MusicalScale) || 'minor'] ?? SCALE_INTERVALS.minor;
  const clamped = Math.max(minMidi, Math.min(maxMidi, Math.round(midi)));

  let best = clamped;
  let bestDist = 999;
  for (let cand = minMidi; cand <= maxMidi; cand++) {
    const pc = ((cand - rootSemi) % 12 + 12) % 12;
    if (intervals.includes(pc)) {
      const dist = Math.abs(cand - clamped);
      if (dist < bestDist) {
        bestDist = dist;
        best = cand;
      }
    }
  }
  return best;
}

function getRoot808ForKey(key: MusicalKey | string): number {
  const semi = KEY_TO_SEMITONE[(key as MusicalKey) || 'C'] ?? 0;
  // Sweet-spot sub-bass register ~31 (G1 = 49Hz) .. 42 (F#2 = 92Hz)
  const cand = 36 + semi;
  return cand > 42 ? cand - 12 : cand;
}

function getRootMelodyForKey(key: MusicalKey | string): number {
  const semi = KEY_TO_SEMITONE[(key as MusicalKey) || 'C'] ?? 0;
  // Bell sample is C5 (MIDI 72); keep root in C4..B4 (60..71) so notes span C4..D5 cleanly
  return 60 + semi;
}

/**
 * Generates a cohesive, spacious, musically locked 64-step (4-bar) Trap arrangement
 * transposed cleanly into the active key & scale.
 */
export function createStyleTrapBeat(
  presetId: TrapStylePresetId,
  bpm?: number,
  key: MusicalKey = 'C',
  scale: MusicalScale = 'minor',
  allowMelodiesOverride?: boolean
): BeatPattern {
  const meta =
    TRAP_STYLE_PRESETS.find((p) => p.id === presetId) ?? TRAP_STYLE_PRESETS[0];
  const resolvedBpm = Math.max(70, Math.min(180, bpm ?? meta.defaultBpm));
  const allowMelodies =
    typeof allowMelodiesOverride === 'boolean'
      ? allowMelodiesOverride && meta.allowMelodies
      : meta.allowMelodies;

  const stepsCount: 64 = 64;
  const tracks: Record<BeatTrackId, BeatStep[]> = {
    '808': makeEmptySteps(stepsCount),
    kick: makeEmptySteps(stepsCount),
    snare: makeEmptySteps(stepsCount),
    clap: makeEmptySteps(stepsCount),
    hihat: makeEmptySteps(stepsCount),
    openhat: makeEmptySteps(stepsCount),
    perc: makeEmptySteps(stepsCount),
    melody: makeEmptySteps(stepsCount),
  };

  const rootBass = getRoot808ForKey(key);
  const rootMel = getRootMelodyForKey(key);
  const degBass = (d: number) =>
    getScaleDegreeMidi(key, scale, d, rootBass - (KEY_TO_SEMITONE[key] ?? 0));
  const degMel = (d: number) =>
    getScaleDegreeMidi(key, scale, d, rootMel - (KEY_TO_SEMITONE[key] ?? 0));

  // Harmonic 808 map (i -> VI -> V / VII) cleanly voiced inside 29..44 MIDI
  const bassI = rootBass;
  const bassVI = snapMidiToScale(degBass(-2), key, scale, 29, 44);
  const bassV = snapMidiToScale(degBass(-3), key, scale, 29, 44);
  const bassIII = snapMidiToScale(degBass(2), key, scale, 31, 46);
  const bassVII = snapMidiToScale(degBass(-1), key, scale, 30, 45);

  let bassHits: Array<{ step: number; note: number; vel: number; slide?: boolean }> = [];
  let kickSteps: Array<{ step: number; vel: number }> = [];
  let snareSteps: Array<{ step: number; vel: number }> = [
    { step: 8, vel: 0.9 },
    { step: 24, vel: 0.9 },
    { step: 40, vel: 0.9 },
    { step: 56, vel: 0.9 },
  ];
  const clapSteps: number[] = [8, 24, 40, 56];
  let rollMap: Record<number, 2 | 3> = { 30: 2, 62: 3 };
  let openHatSteps: number[] = [4, 36];
  let percSteps: number[] = [10, 42];
  let melNotes: Array<{ step: number; deg: number; vel: number }> = [];

  if (presetId === 'trap_americano' || presetId === 'nao_melodico') {
    // Classic spacious Atlanta 4-bar Trap pocket: clean room around Beat 3 snare, zero rushed bar-end mud
    bassHits = [
      { step: 0, note: bassI, vel: 0.92 },
      { step: 6, note: bassI, vel: 0.84 },
      { step: 12, note: bassIII, vel: 0.78 },
      { step: 16, note: bassVI, vel: 0.9 },
      { step: 22, note: bassVI, vel: 0.82 },
      { step: 28, note: bassV, vel: 0.85 },
      { step: 32, note: bassI, vel: 0.92 },
      { step: 38, note: bassI, vel: 0.84 },
      { step: 44, note: bassVII, vel: 0.8 },
      { step: 48, note: bassVI, vel: 0.9 },
      { step: 54, note: bassV, vel: 0.84 },
    ];
    kickSteps = [
      { step: 0, vel: 0.92 },
      { step: 6, vel: 0.84 },
      { step: 16, vel: 0.9 },
      { step: 22, vel: 0.82 },
      { step: 32, vel: 0.92 },
      { step: 38, vel: 0.84 },
      { step: 48, vel: 0.9 },
      { step: 54, vel: 0.84 },
    ];
    snareSteps.push({ step: 62, vel: 0.36 });
    melNotes = [
      { step: 0, deg: 7, vel: 0.56 },
      { step: 8, deg: 4, vel: 0.48 },
      { step: 16, deg: 5, vel: 0.54 },
      { step: 24, deg: 4, vel: 0.46 },
      { step: 32, deg: 7, vel: 0.56 },
      { step: 40, deg: 6, vel: 0.48 },
      { step: 48, deg: 5, vel: 0.54 },
      { step: 56, deg: 4, vel: 0.48 },
    ];
  } else if (presetId === 'dark_trap') {
    bassHits = [
      { step: 0, note: bassI, vel: 0.94 },
      { step: 10, note: bassI, vel: 0.84 },
      { step: 16, note: bassVI, vel: 0.9 },
      { step: 26, note: bassV, vel: 0.84 },
      { step: 32, note: bassI, vel: 0.94 },
      { step: 42, note: bassIII, vel: 0.8 },
      { step: 48, note: bassVI, vel: 0.9 },
      { step: 58, note: bassV, vel: 0.84 },
    ];
    kickSteps = [
      { step: 0, vel: 0.92 },
      { step: 10, vel: 0.84 },
      { step: 16, vel: 0.9 },
      { step: 26, vel: 0.82 },
      { step: 32, vel: 0.92 },
      { step: 48, vel: 0.9 },
      { step: 58, vel: 0.82 },
    ];
    rollMap = { 14: 2, 46: 2, 62: 3 };
    openHatSteps = [2, 34];
    percSteps = [12, 44];
    melNotes = [
      { step: 0, deg: 7, vel: 0.52 },
      { step: 8, deg: 5, vel: 0.44 },
      { step: 16, deg: 5, vel: 0.52 },
      { step: 24, deg: 4, vel: 0.45 },
      { step: 32, deg: 7, vel: 0.52 },
      { step: 40, deg: 8, vel: 0.46 },
      { step: 48, deg: 5, vel: 0.5 },
      { step: 56, deg: 4, vel: 0.45 },
    ];
  } else if (presetId === 'rage_trap') {
    bassHits = [
      { step: 0, note: bassI, vel: 0.94 },
      { step: 4, note: bassI, vel: 0.82 },
      { step: 10, note: bassI, vel: 0.86 },
      { step: 16, note: bassVI, vel: 0.92 },
      { step: 20, note: bassVI, vel: 0.82 },
      { step: 28, note: bassV, vel: 0.88 },
      { step: 32, note: bassI, vel: 0.94 },
      { step: 36, note: bassI, vel: 0.82 },
      { step: 42, note: bassVII, vel: 0.86 },
      { step: 48, note: bassVI, vel: 0.92 },
      { step: 54, note: bassV, vel: 0.88 },
    ];
    kickSteps = [
      { step: 0, vel: 0.94 },
      { step: 10, vel: 0.84 },
      { step: 16, vel: 0.94 },
      { step: 28, vel: 0.84 },
      { step: 32, vel: 0.94 },
      { step: 42, vel: 0.84 },
      { step: 48, vel: 0.94 },
      { step: 54, vel: 0.84 },
    ];
    rollMap = { 30: 3, 62: 3 };
    openHatSteps = [4, 20, 36, 52];
    percSteps = [12, 44];
    melNotes = [
      { step: 0, deg: 7, vel: 0.56 },
      { step: 6, deg: 8, vel: 0.5 },
      { step: 16, deg: 5, vel: 0.56 },
      { step: 22, deg: 7, vel: 0.5 },
      { step: 32, deg: 7, vel: 0.56 },
      { step: 38, deg: 8, vel: 0.5 },
      { step: 48, deg: 5, vel: 0.54 },
      { step: 56, deg: 4, vel: 0.48 },
    ];
  } else if (presetId === 'trap_melodico') {
    bassHits = [
      { step: 0, note: bassI, vel: 0.88 },
      { step: 12, note: bassIII, vel: 0.78 },
      { step: 16, note: bassVI, vel: 0.86 },
      { step: 28, note: bassV, vel: 0.82 },
      { step: 32, note: bassI, vel: 0.88 },
      { step: 44, note: bassVII, vel: 0.8 },
      { step: 48, note: bassVI, vel: 0.86 },
      { step: 58, note: bassV, vel: 0.82 },
    ];
    kickSteps = [
      { step: 0, vel: 0.86 },
      { step: 16, vel: 0.84 },
      { step: 28, vel: 0.74 },
      { step: 32, vel: 0.86 },
      { step: 48, vel: 0.84 },
      { step: 58, vel: 0.76 },
    ];
    rollMap = { 30: 2, 62: 2 };
    openHatSteps = [4, 36];
    percSteps = [14, 46];
    melNotes = [
      { step: 0, deg: 7, vel: 0.58 },
      { step: 6, deg: 8, vel: 0.5 },
      { step: 12, deg: 4, vel: 0.48 },
      { step: 16, deg: 5, vel: 0.56 },
      { step: 24, deg: 7, vel: 0.5 },
      { step: 32, deg: 7, vel: 0.58 },
      { step: 38, deg: 8, vel: 0.5 },
      { step: 44, deg: 6, vel: 0.48 },
      { step: 48, deg: 5, vel: 0.56 },
      { step: 56, deg: 4, vel: 0.5 },
    ];
  } else if (presetId === 'drill_uk') {
    // Classic UK/NY Drill syncopated snare on Beat 3 + Beat 4.5 (steps 8 & 14, 24 & 30)
    snareSteps = [
      { step: 8, vel: 0.88 },
      { step: 14, vel: 0.72 },
      { step: 24, vel: 0.88 },
      { step: 30, vel: 0.72 },
      { step: 40, vel: 0.88 },
      { step: 46, vel: 0.74 },
      { step: 56, vel: 0.88 },
      { step: 62, vel: 0.74 },
    ];
    bassHits = [
      { step: 0, note: bassI, vel: 0.92 },
      { step: 10, note: bassI, vel: 0.84, slide: true },
      { step: 16, note: bassVI, vel: 0.9 },
      { step: 26, note: bassV, vel: 0.84, slide: true },
      { step: 32, note: bassI, vel: 0.92 },
      { step: 42, note: bassIII, vel: 0.84, slide: true },
      { step: 48, note: bassVI, vel: 0.9 },
      { step: 58, note: bassI + 12, vel: 0.8, slide: true },
    ];
    kickSteps = [
      { step: 0, vel: 0.9 },
      { step: 10, vel: 0.82 },
      { step: 16, vel: 0.88 },
      { step: 32, vel: 0.9 },
      { step: 42, vel: 0.82 },
      { step: 48, vel: 0.88 },
    ];
    rollMap = { 22: 2, 54: 2 };
    openHatSteps = [4, 36];
    percSteps = [12, 44];
    melNotes = [
      { step: 0, deg: 7, vel: 0.52 },
      { step: 8, deg: 5, vel: 0.45 },
      { step: 16, deg: 5, vel: 0.52 },
      { step: 24, deg: 4, vel: 0.45 },
      { step: 32, deg: 7, vel: 0.52 },
      { step: 40, deg: 8, vel: 0.46 },
      { step: 48, deg: 5, vel: 0.52 },
      { step: 56, deg: 4, vel: 0.46 },
    ];
  }

  for (const h of bassHits) {
    tracks['808'][h.step] = {
      active: true,
      velocity: h.vel,
      note: h.note,
      slide: Boolean(h.slide),
    };
  }

  for (const k of kickSteps) {
    tracks.kick[k.step] = { active: true, velocity: k.vel };
  }

  for (const s of snareSteps) {
    tracks.snare[s.step] = { active: true, velocity: s.vel };
  }

  for (const c of clapSteps) {
    tracks.clap[c] = { active: true, velocity: 0.78 };
  }

  // Crisp Drill/Trap Hi-Hats with clean groove dynamics
  for (let i = 0; i < stepsCount; i += 2) {
    if (presetId === 'drill_uk' && i % 16 === 4) {
      continue;
    }
    const isRoll = Boolean(rollMap[i]);
    tracks.hihat[i] = {
      active: true,
      velocity: isRoll ? 0.46 : i % 4 === 0 ? 0.68 : 0.42,
      roll: rollMap[i] ?? 1,
    };
  }
  if (presetId === 'drill_uk') {
    for (const st of [3, 19, 35, 51]) {
      tracks.hihat[st] = { active: true, velocity: 0.5, roll: 1 };
    }
  }

  for (const oh of openHatSteps) {
    tracks.openhat[oh] = { active: true, velocity: 0.44 };
  }

  for (const p of percSteps) {
    tracks.perc[p] = { active: true, velocity: 0.44 };
  }

  if (allowMelodies) {
    for (const m of melNotes) {
      tracks.melody[m.step] = {
        active: true,
        velocity: m.vel,
        note: snapMidiToScale(degMel(m.deg), key, scale, 58, 74),
      };
    }
  }

  return {
    stepsCount,
    bpm: resolvedBpm,
    swing: 0,
    tracks,
    mouthEvents: [],
    useExactMouthTiming: false,
    createdFrom: 'manual',
    patternVersion: CURRENT_PATTERN_VERSION,
    descriptionPt: `${meta.label} · 4 compassos (${resolvedBpm} BPM, ${key} ${scale.replace('_', ' ')}).`,
  };
}

export interface RawAiStepItem {
  step: number;
  velocity: number;
  note?: number;
  roll?: number;
  slide?: boolean;
}

/**
 * Deterministic Music-Theory & Trap Groove Sanitizer.
 * Runs after Gemini returns AI beat steps so no generated beat can ever have
 * wrong snare placement, cluttered kick mud, chaotic hi-hats, or shrill out-of-scale notes.
 */
export function sanitizeAndStructureTrapBeat(params: {
  rawTracks: Partial<Record<BeatTrackId, RawAiStepItem[]>>;
  stepsCount: 32 | 64;
  key: MusicalKey | string;
  scale: MusicalScale | string;
  rootNote808: number;
  allowMelodies: boolean;
}): Record<BeatTrackId, BeatStep[]> {
  const { rawTracks, stepsCount, key, scale, rootNote808, allowMelodies } = params;

  const tracks: Record<BeatTrackId, BeatStep[]> = {
    '808': makeEmptySteps(stepsCount),
    kick: makeEmptySteps(stepsCount),
    snare: makeEmptySteps(stepsCount),
    clap: makeEmptySteps(stepsCount),
    hihat: makeEmptySteps(stepsCount),
    openhat: makeEmptySteps(stepsCount),
    perc: makeEmptySteps(stepsCount),
    melody: makeEmptySteps(stepsCount),
  };

  const clampVel = (v: number | undefined, fallback = 0.84) =>
    Math.max(0.32, Math.min(0.94, typeof v === 'number' && !Number.isNaN(v) ? v : fallback));

  const tonicBass = snapMidiToScale(
    getRoot808ForKey(key) || rootNote808,
    key,
    scale,
    29,
    44
  );

  // 1. Snare & Clap: strict half-time Beat 3 anchor (8, 24, 40, 56), optional soft ghost at bar end
  for (let bar = 0; bar < stepsCount / 16; bar++) {
    const backbeat = bar * 16 + 8;
    tracks.snare[backbeat] = { active: true, velocity: 0.9 };
    tracks.clap[backbeat] = { active: true, velocity: 0.78 };
  }
  for (const item of rawTracks.snare || []) {
    const s = Math.round(item.step);
    if (s < 0 || s >= stepsCount) continue;
    const inBar = s % 16;
    if (inBar === 8) {
      tracks.snare[s] = { active: true, velocity: Math.max(0.84, clampVel(item.velocity, 0.9)) };
    } else if ((inBar === 14 || inBar === 15) && (item.velocity ?? 0) <= 0.5) {
      tracks.snare[s] = { active: true, velocity: 0.36 };
    }
  }

  // 2. Kick: minimum 4-step breathing room (clean pocket), never colliding with Beat 3 snare
  let lastKick = -10;
  const rawKicks = [...(rawTracks.kick || [])]
    .filter((k) => k.step >= 0 && k.step < stepsCount)
    .sort((a, b) => a.step - b.step);

  for (const item of rawKicks) {
    const s = Math.round(item.step);
    if (s % 16 === 8) continue;
    if (s - lastKick < 4) continue;
    tracks.kick[s] = { active: true, velocity: clampVel(item.velocity, 0.88) };
    lastKick = s;
  }
  if (!tracks.kick[0].active) {
    tracks.kick[0] = { active: true, velocity: 0.92 };
  }
  if (stepsCount >= 32 && !tracks.kick[16].active) {
    tracks.kick[16] = { active: true, velocity: 0.9 };
  }

  // 3. 808 Bass: locked to scale, minimum 3-step separation (unless slide), tonic anchored on bar 1
  let last808 = -10;
  const raw808 = [...(rawTracks['808'] || [])]
    .filter((b) => b.step >= 0 && b.step < stepsCount)
    .sort((a, b) => a.step - b.step);

  for (const item of raw808) {
    const s = Math.round(item.step);
    if (s % 16 === 8) continue;
    if (s - last808 < 3 && !item.slide) continue;
    const rawNote = typeof item.note === 'number' ? item.note : tonicBass;
    const lockedNote =
      s === 0
        ? tonicBass
        : snapMidiToScale(rawNote, key, scale, 29, 45);
    tracks['808'][s] = {
      active: true,
      velocity: clampVel(item.velocity, 0.88),
      note: lockedNote,
      slide: Boolean(item.slide) && s > 0,
    };
    last808 = s;
  }
  if (!tracks['808'][0].active) {
    tracks['808'][0] = { active: true, velocity: 0.92, note: tonicBass, slide: false };
  }
  if (stepsCount >= 32 && !tracks['808'].slice(16, 22).some((x) => x.active)) {
    tracks['808'][16] = { active: true, velocity: 0.9, note: tonicBass, slide: false };
  }

  // 4. Hi-Hat: steady 8th-note backbone with max 1-2 controlled turnaround rolls
  const aiRolls = new Map<number, 1 | 2 | 3>();
  for (const item of rawTracks.hihat || []) {
    const s = Math.round(item.step);
    if (s >= 0 && s < stepsCount && (item.roll === 2 || item.roll === 3 || item.roll === 4)) {
      const nearestEven = s % 2 === 0 ? s : s - 1;
      if (nearestEven >= 0 && nearestEven % 16 === 14) {
        aiRolls.set(nearestEven, item.roll >= 3 ? 3 : 2);
      }
    }
  }
  for (let i = 0; i < stepsCount; i += 2) {
    const defaultRoll: 1 | 2 | 3 = i === stepsCount - 2 ? 3 : 1;
    const rollVal = aiRolls.get(i) ?? defaultRoll;
    tracks.hihat[i] = {
      active: true,
      velocity: rollVal > 1 ? 0.44 : i % 4 === 0 ? 0.68 : 0.42,
      roll: rollVal,
    };
  }

  // 5. Open Hat: clean off-beat accents (never colliding with snare step 8)
  const rawOh = (rawTracks.openhat || []).filter(
    (o) => o.step >= 0 && o.step < stepsCount && o.step % 16 !== 8 && o.step % 2 === 0
  );
  if (rawOh.length > 0) {
    for (const o of rawOh.slice(0, 2)) {
      tracks.openhat[Math.round(o.step)] = { active: true, velocity: 0.44 };
    }
  } else {
    tracks.openhat[4] = { active: true, velocity: 0.44 };
  }

  // 6. Perc: subtle rim accents off Beat 1 and Beat 3
  const rawPerc = (rawTracks.perc || []).filter(
    (p) => p.step >= 0 && p.step < stepsCount && p.step % 16 !== 8 && p.step % 16 !== 0
  );
  for (const p of rawPerc.slice(0, 3)) {
    tracks.perc[Math.round(p.step)] = { active: true, velocity: 0.44 };
  }

  // 7. Melody: quantized to Beat/Half-Beat anchors (minimum 6-step spacing, strictly C4..D5 58..74)
  if (allowMelodies) {
    let lastMel = -10;
    const rawMel = [...(rawTracks.melody || [])]
      .filter((m) => m.step >= 0 && m.step < stepsCount)
      .sort((a, b) => a.step - b.step);

    for (const item of rawMel) {
      let s = Math.round(item.step);
      if (s % 2 === 1) s = s - 1;
      if (s < 0 || s >= stepsCount) continue;
      if (s - lastMel < 6) continue;
      const melNote = snapMidiToScale(
        typeof item.note === 'number' ? item.note : getRootMelodyForKey(key) + 7,
        key,
        scale,
        58,
        74
      );
      tracks.melody[s] = {
        active: true,
        velocity: Math.min(0.58, clampVel(item.velocity, 0.5)),
        note: melNote,
      };
      lastMel = s;
    }
  }

  return tracks;
}
