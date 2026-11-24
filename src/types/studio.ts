export type StudioMode = 'auto' | 'pro';
export type MonitorMode = 'full' | 'vocal' | 'beat';
export type ExportTrackId = 'vocal' | BeatTrackId;

export type MusicalKey =
  | 'C'
  | 'C#'
  | 'D'
  | 'D#'
  | 'E'
  | 'F'
  | 'F#'
  | 'G'
  | 'G#'
  | 'A'
  | 'A#'
  | 'B';

export type MusicalScale =
  | 'minor'
  | 'harmonic_minor'
  | 'phrygian'
  | 'dorian'
  | 'major'
  | 'chromatic';

export type BeatTrackId =
  | '808'
  | 'kick'
  | 'snare'
  | 'clap'
  | 'hihat'
  | 'openhat'
  | 'perc'
  | 'melody';

export type Style808 = string;

export type Sonority808 = string;

export interface Pack808 {
  id: string;
  name: string;
  description: string;
  style: string;
  license: string;
  isCustom: boolean;
  createdAt: number;
}

export interface Sample808 {
  id: string;
  name: string;
  category: string;
  categories?: string[];
  style: string;
  sonority: string;
  packId: string;
  packName: string;
  tags: string[];
  character: string;
  rootNote: number; // MIDI note (e.g., 36 = C2)
  punch: number; // 0..1
  subDecay: number; // seconds 0.3..2.5
  saturation: number; // 0..1
  glideMs: number; // 0..180
  license: string;
  available: boolean;
  audioUrl?: string;
  durationSec?: number;
  isCustom?: boolean;
  audioBlobKey?: string;
  fileHash?: string;
  artistRef?: string;
  songRef?: string;
  sonicProfile?: string;
}

export interface Ai808Recommendation {
  sampleId: string;
  reasonPt: string;
}

export interface PauseRegion {
  startSec: number;
  endSec: number;
}

export interface DspVocalMetrics {
  durationSec: number;
  sampleRate: number;
  rmsPeakDb: number;
  rmsAvgDb: number;
  estimatedBpm: number;
  detectedKey: MusicalKey;
  detectedScale: MusicalScale;
  medianPitchHz: number;
  entryTimestampsSec: number[];
  pauses: PauseRegion[];
  energyCurve: number[]; // normalized 0..1 across 32 slices
}

export interface VocalAnalysisResult {
  bpm: number;
  detectedKey: MusicalKey;
  detectedScale: MusicalScale;
  cadence: string;
  intensityProfile: string;
  entriesSec: number[];
  pauses: PauseRegion[];
  recommended808Id: string;
  summaryPt: string;
  analyzedAt: number;
}

export interface BeatDirectionConstraints {
  rawPrompt: string;
  allowMelodies: boolean;
  allowPiano: boolean;
  allowSynths: boolean;
  mood: 'dark' | 'aggressive' | 'melodic' | 'minimal' | 'bouncy' | 'heavy';
  sub808Intensity: 'low' | 'medium' | 'high' | 'extreme';
  drumDensity: 'sparse' | 'balanced' | 'explosive';
  hihatStyle: 'simple' | 'trap_rolls' | 'fast';
  summaryPt: string;
}

export interface BeatStep {
  active: boolean;
  velocity: number; // 0.1 .. 1.0
  note?: number; // MIDI note for 808 or melody
  roll?: 1 | 2 | 3 | 4; // subdivisions inside 16th step
  slide?: boolean; // pitch glide for 808
}

export interface MouthHitEvent {
  timeSec: number;
  instrument: BeatTrackId;
  velocity: number;
  note?: number;
}

export interface BeatPattern {
  stepsCount: 32 | 64; // 2 bars or 4 bars of 16th notes
  bpm: number;
  swing: number; // 0..0.35
  tracks: Record<BeatTrackId, BeatStep[]>;
  mouthEvents: MouthHitEvent[];
  useExactMouthTiming: boolean;
  createdFrom: 'auto' | 'mouth' | 'manual';
  descriptionPt: string;
  patternVersion?: number;
}

export interface AutotuneSettings {
  enabled: boolean;
  retuneSpeedMs: number; // 0 (hard trap) .. 120 (natural)
  mix: number; // 0 .. 1
  humanize: number; // 0 .. 1
  key: MusicalKey;
  scale: MusicalScale;
  preserveFormants: boolean;
}

export interface TrackMixSettings {
  volume: number; // 0 .. 1.2
  pan: number; // -1 .. 1
  mute: boolean;
  solo: boolean;
  eqLow: number; // -12 .. +12 dB
  eqMid: number; // -12 .. +12 dB
  eqHigh: number; // -12 .. +12 dB
}

export interface VocalFxSettings {
  gainDb: number; // -12 .. +12
  compression: number; // 0 .. 1
  reverb: number; // 0 .. 1
  delay: number; // 0 .. 1
  deEsser: number; // 0 .. 1
  offsetMs: number; // -200 .. +200 alignment vs beat
}

export interface MasterSettings {
  limiterEnabled: boolean;
  clipperDrive: number; // 0 .. 1
  outputGain: number; // 0.4 .. 1.2
}

export type MixerChannels = Record<'vocal' | BeatTrackId, TrackMixSettings>;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  modelUsed?: string;
  timestamp: number;
}

export interface TrapProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  mode: StudioMode;
  bpm: number;
  key: MusicalKey;
  scale: MusicalScale;
  vocalBlobKey: string | null;
  vocalFileName: string | null;
  vocalDurationSec: number;
  vocalDsp: DspVocalMetrics | null;
  vocalAnalysis: VocalAnalysisResult | null;
  mouthBlobKey: string | null;
  mouthDurationSec: number;
  selected808Id: string;
  lock808Selection: boolean;
  auto808Mode: boolean;
  directionPrompt: string;
  directionConstraints: BeatDirectionConstraints;
  beatPattern: BeatPattern;
  autotune: AutotuneSettings;
  vocalFx: VocalFxSettings;
  mixer: MixerChannels;
  master: MasterSettings;
  coverArtDataUrl: string | null;
  chatHistory: ChatMessage[];
}
