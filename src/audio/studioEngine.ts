import {
  BeatTrackId,
  ExportTrackId,
  MixerChannels,
  MonitorMode,
  MouthHitEvent,
  Sample808,
  TrapProject,
} from '../types/studio';
import { processVocalWithAutotune } from './autotuneEngine';
import {
  STUDIO_KIT_URLS,
  TriggeredVoice,
  trigger808Sound,
  triggerKitSample,
} from './library808';

type KitTrackId = Exclude<BeatTrackId, '808'>;

const MAX_STUDIO_SAMPLE_BYTES = 32 * 1024 * 1024;
const STUDIO_SAMPLE_FETCH_TIMEOUT_MS = 20_000;

// Gentle kick-to-808 ducking: enough room for the kick transient without
// collapsing the sustained sub-bass. Keep live and offline rendering identical.
const KICK_808_DUCK_GAIN = 0.48;
const KICK_808_DUCK_ATTACK_SEC = 0.006;
const KICK_808_DUCK_HOLD_SEC = 0.012;
const KICK_808_DUCK_RELEASE_SEC = 0.045;

/** Fetch and decode a studio WAV with bounded time, size and basic file validation. */
async function fetchStudioWav(ctx: BaseAudioContext, url: string, label: string): Promise<AudioBuffer> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    STUDIO_SAMPLE_FETCH_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`Falha ao carregar ${label} (${response.status}).`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_STUDIO_SAMPLE_BYTES) {
      throw new Error(`${label} excede o limite de tamanho permitido.`);
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength < 44 || bytes.byteLength > MAX_STUDIO_SAMPLE_BYTES) {
      throw new Error(`${label} tem um tamanho inválido ou excede o limite permitido.`);
    }

    const header = new DataView(bytes);
    const isRiff = header.getUint32(0, false) === 0x52494646;
    const isWave = header.getUint32(8, false) === 0x57415645;
    if (!isRiff || !isWave) {
      throw new Error(`${label} não é um ficheiro WAV válido.`);
    }

    return await ctx.decodeAudioData(bytes.slice(0));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`O carregamento de ${label} excedeu 20 segundos. Verifica a ligação à internet.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

const VALID_BEAT_TRACK_IDS = new Set<BeatTrackId>([
  '808', 'kick', 'snare', 'clap', 'hihat', 'openhat', 'perc', 'melody',
]);

/** Normalize persisted/AI-produced mouth events before scheduling or export. */
function getOrderedMouthEvents(project: TrapProject): MouthHitEvent[] {
  return (Array.isArray(project.beatPattern.mouthEvents) ? project.beatPattern.mouthEvents : [])
    .filter((event) =>
      event &&
      Number.isFinite(event.timeSec) && event.timeSec >= 0 &&
      VALID_BEAT_TRACK_IDS.has(event.instrument)
    )
    .map((event) => ({
      timeSec: event.timeSec,
      instrument: event.instrument,
      velocity: Number.isFinite(event.velocity)
        ? Math.max(0.1, Math.min(1, event.velocity))
        : 0.85,
      note: Number.isFinite(event.note) ? event.note : undefined,
    }))
    .sort((a, b) => a.timeSec - b.timeSec);
}

function getNext808SlideNote(project: TrapProject, stepIndex: number, fallbackNote: number): number {
  const steps = project.beatPattern?.tracks?.['808'] ?? [];
  if (!steps.length) return fallbackNote;
  for (let offset = 1; offset <= steps.length; offset++) {
    const candidate = steps[(stepIndex + offset) % steps.length];
    if (candidate?.active && Number.isFinite(candidate.note)) {
      return Math.max(0, Math.min(127, Number(candidate.note)));
    }
  }
  return fallbackNote;
}

const KEY_PITCH_CLASS: Record<TrapProject['key'], number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
  'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

const SCALE_INTERVALS: Record<TrapProject['scale'], number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** Snap a MIDI note to the nearest note in the project's key/scale. */
function snap808NoteToProjectScale(project: TrapProject, rawNote: number): number {
  const note = Number.isFinite(rawNote) ? Math.max(0, Math.min(127, Math.round(rawNote))) : 36;
  const key = KEY_PITCH_CLASS[project.key];
  const intervals = SCALE_INTERVALS[project.scale];
  // Old or malformed projects fall back to the original note rather than
  // unexpectedly changing the artist's pattern.
  if (!Number.isFinite(key) || !intervals || project.scale === 'chromatic') return note;

  let bestNote = note;
  let bestDistance = Infinity;
  for (let candidate = Math.max(0, note - 6); candidate <= Math.min(127, note + 6); candidate++) {
    const pitchClassFromRoot = (candidate - key + 120) % 12;
    if (!intervals.includes(pitchClassFromRoot)) continue;
    const distance = Math.abs(candidate - note);
    if (distance < bestDistance || (distance === bestDistance && candidate < bestNote)) {
      bestDistance = distance;
      bestNote = candidate;
    }
  }
  return bestNote;
}

function getMouthLoopLength(events: MouthHitEvent[], loopDuration: number, stepDuration: number): number {
  const lastEventTime = events.length ? events[events.length - 1].timeSec : 0;
  const barDuration = stepDuration * 16;
  // Leave at least one sixteenth-note after the final event so an event exactly
  // on a bar boundary is not replayed at the same instant as the next cycle.
  const requiredBars = Math.ceil((lastEventTime + stepDuration) / barDuration);
  return Math.max(loopDuration, Math.max(1, requiredBars) * barDuration);
}

interface ChannelStrip {
  input: GainNode;
  gate: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  dynamicLowMid: BiquadFilterNode | null;
  panner: StereoPannerNode;
}

function createSimpleImpulse(ctx: BaseAudioContext, seconds = 1.1, decay = 2.6): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return impulse;
}

function makeMasterClipperCurve(drive: number): Float32Array<ArrayBuffer> {
  // A denser transfer curve reduces coarse stepping; 4x oversampling below
  // further reduces high-frequency aliasing from nonlinear saturation.
  const n = 2048;
  const buf = new ArrayBuffer(n * 4);
  const curve = new Float32Array(buf);
  const safeDrive = Number.isFinite(drive) ? Math.max(0, Math.min(1, drive)) : 0.25;
  const k = 1 + safeDrive * 2.2;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

function createMasterClipper(ctx: BaseAudioContext, drive: number): WaveShaperNode {
  const clipper = ctx.createWaveShaper();
  clipper.curve = makeMasterClipperCurve(drive);
  clipper.oversample = '4x';
  return clipper;
}

/** Gentle vocal rumble filter; keeps the 808/sub range out of the vocal bus. */
function createVocalRumbleFilter(ctx: BaseAudioContext): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  // A conservative cutoff removes handling/room rumble without aggressively
  // thinning lower male voices. The same setting is used live and offline.
  filter.frequency.value = 55;
  filter.Q.value = Math.SQRT1_2;
  return filter;
}

/**
 * Apply a gentle, vocal-keyed reduction only in the 808 low-mid region.
 * This is dynamic EQ (not broadband volume ducking): the deepest sub remains
 * intact while vocal phrases briefly make room around 185 Hz.
 */
function scheduleVocalMasking(
  filter: BiquadFilterNode | null,
  vocal: AudioBuffer | null,
  startAt: number,
  bufferOffsetSec = 0
) {
  if (!filter || !vocal || !Number.isFinite(vocal.duration) || vocal.duration <= 0) return;
  const safeOffset = Math.max(0, Math.min(vocal.duration, bufferOffsetSec));
  const sampleRate = vocal.sampleRate;
  const windowSize = Math.max(128, Math.floor(sampleRate * 0.02));
  const totalFrames = Math.max(0, vocal.length - Math.floor(safeOffset * sampleRate));
  if (totalFrames < windowSize) return;

  const points = Math.min(2048, Math.max(2, Math.ceil(totalFrames / windowSize)));
  const curve = new Float32Array(points);
  const channels = Math.max(1, vocal.numberOfChannels);
  const firstFrame = Math.floor(safeOffset * sampleRate);
  for (let point = 0; point < points; point++) {
    const relativeStart = Math.floor((point / points) * totalFrames);
    const frameStart = firstFrame + relativeStart;
    const frameEnd = Math.min(vocal.length, frameStart + windowSize);
    let sumSquares = 0;
    let count = 0;
    for (let channel = 0; channel < channels; channel++) {
      const data = vocal.getChannelData(channel);
      for (let frame = frameStart; frame < frameEnd; frame += 2) {
        const value = data[frame];
        sumSquares += value * value;
        count++;
      }
    }
    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
    const db = rms > 0 ? 20 * Math.log10(rms) : -96;
    // Fade in gently above -38 dBFS; cap the reduction at 2.5 dB.
    const activity = Math.max(0, Math.min(1, (db + 38) / 20));
    curve[point] = -2.5 * activity;
  }
  const duration = totalFrames / sampleRate;
  if (duration > 0) {
    filter.gain.setValueCurveAtTime(curve, startAt, duration);
  }
}

function buildChannelChain(
  ctx: BaseAudioContext,
  mix: MixerChannels[keyof MixerChannels],
  dest: AudioNode,
  initiallyAudible: boolean,
  enableVocalMasking = false
): ChannelStrip {
  const input = ctx.createGain();
  input.gain.value = mix.volume;

  const gate = ctx.createGain();
  gate.gain.value = initiallyAudible ? 1 : 0;

  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 110;
  low.gain.value = mix.eqLow;

  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1150;
  mid.Q.value = 1.0;
  mid.gain.value = mix.eqMid;

  const dynamicLowMid = enableVocalMasking ? ctx.createBiquadFilter() : null;
  if (dynamicLowMid) {
    dynamicLowMid.type = 'peaking';
    dynamicLowMid.frequency.value = 185;
    dynamicLowMid.Q.value = 0.85;
    dynamicLowMid.gain.value = 0;
  }

  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 6500;
  high.gain.value = mix.eqHigh;

  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, mix.pan));

  input.connect(gate);
  gate.connect(low);
  if (dynamicLowMid) {
    low.connect(dynamicLowMid);
    dynamicLowMid.connect(mid);
  } else {
    low.connect(mid);
  }
  mid.connect(high);
  high.connect(panner);
  panner.connect(dest);

  return { input, gate, low, mid, high, dynamicLowMid, panner };
}

function isChannelAudible(
  channelId: 'vocal' | BeatTrackId,
  mixer: MixerChannels,
  monitorMode: MonitorMode,
  forcedTrack?: ExportTrackId | null
): boolean {
  if (forcedTrack && channelId !== forcedTrack) return false;
  if (monitorMode === 'vocal' && channelId !== 'vocal') return false;
  if (monitorMode === 'beat' && channelId === 'vocal') return false;

  const anySolo = !forcedTrack && Object.values(mixer ?? {}).some((m) => m?.solo);
  const ch = mixer?.[channelId];
  if (!ch || ch.mute) return false;
  if (anySolo && !ch.solo) return false;
  return true;
}

/** Return only the kit tracks that can actually be heard in this session.
 * This avoids downloading unrelated samples (especially in vocal-only mode).
 */
function getRequiredKitTracks(
  project: TrapProject,
  monitorMode: MonitorMode,
  forcedTrack?: ExportTrackId | null
): KitTrackId[] {
  const kitTrackIds: KitTrackId[] = [
    'kick', 'snare', 'clap', 'hihat', 'openhat', 'perc', 'melody',
  ];
  return kitTrackIds.filter((trackId) => {
    if (!isChannelAudible(trackId, project.mixer, monitorMode, forcedTrack)) return false;
    if (trackId === 'melody' && !project.directionConstraints?.allowMelodies) return false;
    if (project.beatPattern?.useExactMouthTiming) {
      const events = Array.isArray(project.beatPattern?.mouthEvents)
        ? project.beatPattern.mouthEvents
        : [];
      return events.some((event) => event?.instrument === trackId);
    }
    const steps = project.beatPattern?.tracks?.[trackId];
    return Array.isArray(steps) && steps.some((step) => Boolean(step?.active));
  });
}

function chokeVoiceAt(voice: TriggeredVoice | null, time: number, fadeSec = 0.01) {
  if (!voice) return;
  try {
    const t = Math.max(0, time);
    const param = voice.gain.gain as AudioParam & { cancelAndHoldAtTime?: (cancelTime: number) => AudioParam };
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(t);
    } else {
      param.cancelScheduledValues(t);
    }
    param.setTargetAtTime(0.0001, t, Math.max(0.002, fadeSec / 3));
    voice.source.stop(t + fadeSec + 0.012);
  } catch {
    // voice already stopped
  }
}

export class StudioAudioEngine {
  private ctx: AudioContext | null = null;
  private isPlaying = false;
  private playbackToken = 0;
  private timerId: number | null = null;
  private startCtxTime = 0;
  private totalStepsScheduled = 0;
  private mouthLoopIndex = 0;
  private currentLoopCycle = 0;

  private activeMasterBus: GainNode | null = null;
  private active808Sidechain: GainNode | null = null;
  private activeChannels: Partial<Record<'vocal' | BeatTrackId, ChannelStrip>> = {};
  private activeSources = new Set<AudioBufferSourceNode>();
  private activeVocalSource: AudioBufferSourceNode | null = null;
  private active808Voice: TriggeredVoice | null = null;
  private activeOpenHatVoice: TriggeredVoice | null = null;
  private activeMelodyVoice: TriggeredVoice | null = null;
  private activePreviewSource: AudioBufferSourceNode | null = null;

  private analyser: AnalyserNode | null = null;
  private meterRaf: number | null = null;

  private sampleBufferCache = new Map<string, AudioBuffer>();
  private kitBuffers: Partial<Record<KitTrackId, AudioBuffer>> = {};
  private kitLoadPromise: Promise<Partial<Record<KitTrackId, AudioBuffer>>> | null = null;

  private projectRef: TrapProject | null = null;
  private monitorMode: MonitorMode = 'full';
  private vocalRawBuffer: AudioBuffer | null = null;
  private vocalProcessedBuffer: AudioBuffer | null = null;
  private autotuneCacheKey = '';
  private selected808: Sample808 | null = null;
  private active808Buffer: AudioBuffer | null = null;

  public ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public async decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
    // Compressed files can expand dramatically when decoded. Bound both the
    // upload size and the decoded sample count to protect mobile browsers.
    const maxCompressedBytes = 50 * 1024 * 1024;
    const maxDecodedSamples = 30_000_000;
    if (!(blob instanceof Blob) || blob.size < 64) {
      throw new Error('O ficheiro de áudio está vazio ou é demasiado pequeno.');
    }
    if (blob.size > maxCompressedBytes) {
      throw new Error('O ficheiro excede 50 MB. Escolhe um áudio mais pequeno.');
    }

    const ctx = this.ensureContext();
    let decoded: AudioBuffer;
    try {
      const arrayBuf = await blob.arrayBuffer();
      decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
    } catch {
      throw new Error('Não foi possível descodificar este áudio. Experimenta WAV, MP3, M4A, OGG ou WebM compatível com o navegador.');
    }

    const totalSamples = decoded.length * decoded.numberOfChannels;
    if (
      !Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 600 ||
      decoded.numberOfChannels < 1 || decoded.numberOfChannels > 2 ||
      decoded.sampleRate < 8000 || decoded.sampleRate > 96000 ||
      totalSamples > maxDecodedSamples
    ) {
      throw new Error('Este áudio excede os limites suportados: até 10 minutos, 2 canais e 30 milhões de amostras.');
    }
    return decoded;
  }

  public async ensureKitBuffers(
    requestedTrackIds: KitTrackId[] = Object.keys(STUDIO_KIT_URLS) as KitTrackId[]
  ): Promise<Partial<Record<KitTrackId, AudioBuffer>>> {
    const trackIds = [...new Set(requestedTrackIds)];
    if (trackIds.length === 0) return this.kitBuffers;
    const missingIds = trackIds.filter((id) => !this.kitBuffers[id]);
    if (missingIds.length === 0) return this.kitBuffers;

    // Serialize concurrent loads; a later caller rechecks which tracks remain missing.
    if (this.kitLoadPromise) {
      await this.kitLoadPromise;
      return this.ensureKitBuffers(trackIds);
    }

    const ctx = this.ensureContext();
    this.kitLoadPromise = (async () => {
      await Promise.all(
        missingIds.map(async (id) => {
          const url = STUDIO_KIT_URLS[id];
          const decoded = await fetchStudioWav(ctx, url, `sample do kit ${id}`);
          this.kitBuffers[id] = decoded;
        })
      );
      return this.kitBuffers;
    })();

    try {
      return await this.kitLoadPromise;
    } finally {
      this.kitLoadPromise = null;
    }
  }

  public async load808Buffer(
    sample: Sample808,
    customBlob?: Blob | null
  ): Promise<AudioBuffer> {
    if (!sample.available) {
      throw new Error(`O sample "${sample.name}" ainda está em preparação (Em breve).`);
    }

    const cacheKey = sample.isCustom
      ? `custom:${sample.id}:${sample.audioBlobKey ?? ''}`
      : `url:${sample.audioUrl ?? ''}`;

    const cached = this.sampleBufferCache.get(cacheKey);
    if (cached) return cached;

    const ctx = this.ensureContext();
    if (sample.isCustom) {
      if (!customBlob) {
        throw new Error(`Ficheiro de áudio não encontrado para "${sample.name}".`);
      }
      const decoded = await this.decodeAudioBlob(customBlob);
      this.sampleBufferCache.set(cacheKey, decoded);
      return decoded;
    }

    if (!sample.audioUrl) {
      throw new Error(`Este sample não possui ficheiro de áudio associado.`);
    }

    const decoded = await fetchStudioWav(ctx, sample.audioUrl, `o sample 808 ${sample.name}`);
    this.sampleBufferCache.set(cacheKey, decoded);
    return decoded;
  }

  public stopPreview808() {
    if (this.activePreviewSource) {
      try {
        this.activePreviewSource.stop();
      } catch {
        // already stopped
      }
      this.activePreviewSource = null;
    }
  }

  public async preview808(
    sample: Sample808,
    customBlob?: Blob | null,
    midiNote = 36
  ): Promise<void> {
    // Strictly isolate 808 demo from any active song/beat playback
    this.stopPlayback();
    this.stopPreview808();

    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    const buffer = await this.load808Buffer(sample, customBlob);
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.92;
    masterGain.connect(ctx.destination);

    const voice = trigger808Sound(
      ctx,
      masterGain,
      sample,
      buffer,
      ctx.currentTime + 0.012,
      midiNote,
      0.95,
      false
    );
    this.activePreviewSource = voice?.source ?? null;
  }

  public updateSessionData(params: {
    project: TrapProject;
    monitorMode: MonitorMode;
    vocalBuffer: AudioBuffer | null;
    selected808: Sample808;
    active808Buffer: AudioBuffer | null;
  }) {
    this.projectRef = params.project;
    this.monitorMode = params.monitorMode;
    this.selected808 = params.selected808;
    this.active808Buffer = params.active808Buffer;

    if (params.vocalBuffer !== this.vocalRawBuffer) {
      this.vocalRawBuffer = params.vocalBuffer;
      this.autotuneCacheKey = '';
    }
    this.refreshAutotuneCacheIfNeeded();

    if (this.isPlaying && this.ctx) {
      this.applyLiveMixState();
    }
  }

  private applyLiveMixState() {
    if (!this.ctx || !this.projectRef) return;
    const now = this.ctx.currentTime;
    const proj = this.projectRef;
    const allIds: Array<'vocal' | BeatTrackId> = [
      'vocal',
      '808',
      'kick',
      'snare',
      'clap',
      'hihat',
      'openhat',
      'perc',
      'melody',
    ];

    for (const id of allIds) {
      const strip = this.activeChannels[id];
      if (!strip) continue;
      const mix = proj.mixer[id];
      const audible = isChannelAudible(id, proj.mixer, this.monitorMode);

      strip.input.gain.setTargetAtTime(mix.volume, now, 0.012);
      strip.gate.gain.setTargetAtTime(audible ? 1 : 0, now, 0.01);
      strip.low.gain.setTargetAtTime(mix.eqLow, now, 0.015);
      strip.mid.gain.setTargetAtTime(mix.eqMid, now, 0.015);
      strip.high.gain.setTargetAtTime(mix.eqHigh, now, 0.015);
      strip.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, mix.pan)), now, 0.015);
    }

    if (this.activeMasterBus) {
      this.activeMasterBus.gain.setTargetAtTime(proj.master.outputGain * 0.88, now, 0.015);
    }
  }

  private refreshAutotuneCacheIfNeeded() {
    if (!this.vocalRawBuffer || !this.projectRef) {
      this.vocalProcessedBuffer = null;
      return;
    }
    const at = this.projectRef.autotune;
    const sig = `${at.enabled}_${at.retuneSpeedMs}_${at.mix}_${at.humanize}_${at.key}_${at.scale}_${at.preserveFormants}`;
    if (sig === this.autotuneCacheKey && this.vocalProcessedBuffer) return;

    const ctx = this.ensureContext();
    this.vocalProcessedBuffer = processVocalWithAutotune(ctx, this.vocalRawBuffer, at);
    this.autotuneCacheKey = sig;
  }

  public async startPlayback(
    onTick: (step: number, elapsedSec: number, meterLevel: number) => void,
    onStop?: () => void
  ) {
    if (!this.projectRef || !this.selected808) return;
    this.stopPreview808();
    this.stopPlayback();

    const token = ++this.playbackToken;
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    const requiredKitTracks = getRequiredKitTracks(this.projectRef, this.monitorMode);
    if (requiredKitTracks.length > 0) {
      await this.ensureKitBuffers(requiredKitTracks);
    }
    if (token !== this.playbackToken || !this.projectRef || !this.selected808) {
      return;
    }

    this.refreshAutotuneCacheIfNeeded();

    const project = this.projectRef;
    this.isPlaying = true;
    this.totalStepsScheduled = 0;
    this.mouthLoopIndex = 0;
    this.currentLoopCycle = 0;
    this.active808Voice = null;
    this.activeOpenHatVoice = null;
    this.activeMelodyVoice = null;
    this.startCtxTime = ctx.currentTime + 0.06;

    const masterBus = ctx.createGain();
    masterBus.gain.value = project.master.outputGain * 0.88;
    this.activeMasterBus = masterBus;

    const clipper = createMasterClipper(ctx, project.master.clipperDrive);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = project.master.limiterEnabled ? -2.0 : 0;
    limiter.knee.value = project.master.limiterEnabled ? 2 : 4;
    limiter.ratio.value = project.master.limiterEnabled ? 12 : 1;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;

    masterBus.connect(clipper);
    clipper.connect(limiter);
    limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Build ONE persistent mixer channel strip per track
    const channelIds: Array<'vocal' | BeatTrackId> = [
      'vocal',
      '808',
      'kick',
      'snare',
      'clap',
      'hihat',
      'openhat',
      'perc',
      'melody',
    ];
    this.activeChannels = {};
    for (const id of channelIds) {
      this.activeChannels[id] = buildChannelChain(
        ctx,
        project.mixer[id],
        masterBus,
        isChannelAudible(id, project.mixer, this.monitorMode),
        id === '808'
      );
    }

    // Dedicated Kick-to-808 sidechain ducking stage so Kick punch never clashes with 808 sub
    this.active808Sidechain = ctx.createGain();
    this.active808Sidechain.gain.value = 1;
    if (this.activeChannels['808']) {
      this.active808Sidechain.connect(this.activeChannels['808'].input);
    }

    // Schedule artist vocal synced cleanly to step 0 (gated by monitorMode so switching Full<->Beat stays locked!)
    const vocalBuf = this.vocalProcessedBuffer || this.vocalRawBuffer;
    const rawVocalOffsetMs = project.vocalFx?.offsetMs ?? 0;
    const vocalOffsetSec = (Number.isFinite(rawVocalOffsetMs) ? Math.max(-200, Math.min(200, rawVocalOffsetMs)) : 0) / 1000;
    scheduleVocalMasking(
      isChannelAudible('vocal', project.mixer, this.monitorMode)
        ? this.activeChannels['808']?.dynamicLowMid ?? null
        : null,
      vocalBuf,
      this.startCtxTime + Math.max(0, vocalOffsetSec),
      Math.max(0, -vocalOffsetSec)
    );
    const vocalStrip = this.activeChannels.vocal;
    if (vocalBuf && vocalStrip) {
      const fx = project.vocalFx ?? { gainDb: 0, compression: 0.35, deEsser: 0, reverb: 0, delay: 0, offsetMs: 0 };
      const fxNumber = (value: number, fallback: number, min: number, max: number) =>
        Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
      const gainDb = fxNumber(fx.gainDb, 0, -24, 24);
      const compression = fxNumber(fx.compression, 0.35, 0, 1);
      const deEsserAmount = fxNumber(fx.deEsser, 0, 0, 1);
      const reverbAmount = fxNumber(fx.reverb, 0, 0, 1);
      const delayAmount = fxNumber(fx.delay, 0, 0, 1);
      const offsetMs = fxNumber(fx.offsetMs, 0, -200, 200);

      const vocalRumbleFilter = createVocalRumbleFilter(ctx);
      const preGain = ctx.createGain();
      preGain.gain.value = Math.pow(10, gainDb / 20);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24 + (1 - compression) * 18;
      comp.ratio.value = 1 + compression * 7;
      comp.attack.value = 0.004;
      comp.release.value = 0.14;

      const deEsser = ctx.createBiquadFilter();
      deEsser.type = 'peaking';
      deEsser.frequency.value = 6800;
      deEsser.Q.value = 2.4;
      deEsser.gain.value = -deEsserAmount * 9;

      const dryGain = ctx.createGain();
      dryGain.gain.value = 1;

      const revGain = ctx.createGain();
      revGain.gain.value = reverbAmount * 0.65;
      const convolver = ctx.createConvolver();
      convolver.buffer = createSimpleImpulse(ctx, 1.35, 2.8);

      const delayNode = ctx.createDelay(1.0);
      delayNode.delayTime.value = Math.min(0.8, 60 / Math.max(60, project.bpm) / 2);
      const delayFeedback = ctx.createGain();
      delayFeedback.gain.value = 0.28;
      const delayMix = ctx.createGain();
      delayMix.gain.value = delayAmount * 0.45;

      preGain.connect(deEsser);
      deEsser.connect(comp);
      comp.connect(dryGain);
      dryGain.connect(vocalStrip.input);

      comp.connect(convolver);
      convolver.connect(revGain);
      revGain.connect(vocalStrip.input);

      comp.connect(delayNode);
      delayNode.connect(delayFeedback);
      delayFeedback.connect(delayNode);
      delayNode.connect(delayMix);
      delayMix.connect(vocalStrip.input);

      const vSrc = ctx.createBufferSource();
      vSrc.buffer = vocalBuf;
      vSrc.connect(vocalRumbleFilter);
      vocalRumbleFilter.connect(preGain);

      const offsetSec = offsetMs / 1000;
      if (offsetSec >= 0) {
        vSrc.start(this.startCtxTime + offsetSec);
      } else {
        vSrc.start(this.startCtxTime, Math.min(vocalBuf.duration, Math.abs(offsetSec)));
      }
      this.activeVocalSource = vSrc;
      this.activeSources.add(vSrc);
      vSrc.onended = () => this.activeSources.delete(vSrc);
    }

    const scheduleLoop = () => {
      if (!this.isPlaying || !this.ctx || !this.projectRef || !this.selected808) return;
      const proj = this.projectRef;
      const pat = proj.beatPattern;
      const stepDur = 60 / Math.max(60, proj.bpm) / 4;
      const lookahead = 0.14;

      const mouthEvents = pat.useExactMouthTiming ? getOrderedMouthEvents(proj) : [];
      if (mouthEvents.length > 0) {
        const loopLengthSec = getMouthLoopLength(mouthEvents, stepDur * pat.stepsCount, stepDur);
        while (this.isPlaying) {
          const ev = mouthEvents[this.mouthLoopIndex];
          if (!ev) break;
          const evTime = this.startCtxTime + this.currentLoopCycle * loopLengthSec + ev.timeSec;
          if (evTime > this.ctx.currentTime + lookahead) break;

          this.triggerInstrumentEvent(
            this.ctx,
            ev.instrument,
            evTime,
            ev.velocity,
            ev.note ?? (ev.instrument === '808' ? this.selected808.rootNote : 60),
            false
          );

          this.mouthLoopIndex++;
          if (this.mouthLoopIndex >= mouthEvents.length) {
            this.mouthLoopIndex = 0;
            this.currentLoopCycle++;
          }
        }
      } else {
        while (this.isPlaying) {
          // Exact step-index timestamp avoids cumulative floating-point drift
          const stepExactTime = this.startCtxTime + this.totalStepsScheduled * stepDur;
          if (stepExactTime >= this.ctx.currentTime + lookahead) break;

          const stepIdx = this.totalStepsScheduled % pat.stepsCount;
          const isOddStep = stepIdx % 2 === 1;
          const swingShift = isOddStep ? pat.swing * stepDur : 0;

          const trackIds: BeatTrackId[] = [
            '808',
            'kick',
            'snare',
            'clap',
            'hihat',
            'openhat',
            'perc',
            'melody',
          ];

          for (const tr of trackIds) {
            if (tr === 'melody' && !proj.directionConstraints.allowMelodies) continue;
            const step = pat.tracks?.[tr]?.[stepIdx];
            if (!step || !step.active) continue;

            // Keep Kick, 808, Snare, Clap, and Melody strictly locked on grid; subtle Trap swing only on hats & perc
            const t = tr === 'hihat' || tr === 'perc' ? stepExactTime + swingShift : stepExactTime;

            const rolls = Number.isFinite(step.roll) && step.roll > 1 ? Math.min(8, Math.floor(step.roll)) : 1;
            for (let r = 0; r < rolls; r++) {
              const rTime = t + (r * stepDur) / rolls;
              const rollVelScale = rolls > 1 ? 0.68 + (r / rolls) * 0.28 : 1;
              this.triggerInstrumentEvent(
                this.ctx,
                tr,
                rTime,
                (Number.isFinite(step.velocity) ? Math.max(0, Math.min(1, step.velocity)) : 0.85) * rollVelScale,
                step.note ?? (tr === '808' ? this.selected808.rootNote : 60),
                Boolean(step.slide),
                tr === '808' && step.slide
                  ? getNext808SlideNote(proj, stepIdx, step.note ?? this.selected808.rootNote)
                  : undefined
              );
            }
          }

          this.totalStepsScheduled++;
        }
      }
    };

    scheduleLoop();
    this.timerId = window.setInterval(scheduleLoop, 25);

    const dataArr = new Uint8Array(this.analyser.frequencyBinCount);
    const updateMeter = () => {
      if (!this.isPlaying || !this.ctx || !this.analyser || !this.projectRef) return;
      this.analyser.getByteTimeDomainData(dataArr);
      let sum = 0;
      for (let i = 0; i < dataArr.length; i++) {
        const v = (dataArr[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArr.length);
      const elapsed = Math.max(0, this.ctx.currentTime - this.startCtxTime);
      const stepDur = 60 / Math.max(60, this.projectRef.bpm) / 4;
      const visualStep = Math.floor(elapsed / stepDur) % this.projectRef.beatPattern.stepsCount;

      onTick(visualStep, elapsed, Math.min(1, rms * 2.8));

      if (
        this.monitorMode === 'vocal' &&
        vocalBuf &&
        elapsed > vocalBuf.duration + 0.4
      ) {
        this.stopPlayback();
        onStop?.();
        return;
      }

      this.meterRaf = requestAnimationFrame(updateMeter);
    };
    this.meterRaf = requestAnimationFrame(updateMeter);
  }

  private applySidechainDuck(duckGain: GainNode | null, time: number) {
    if (!duckGain || !Number.isFinite(time)) return;
    const param = duckGain.gain;
    // The live scheduler can occasionally wake late on slower phones. Never
    // submit an automation event in the past; keep a short, click-free duck.
    const t = Math.max(0, time, duckGain.context.currentTime + 0.002);
    // A fresh kick starts a fresh duck envelope; automation is scheduled at
    // the kick timestamp so offline and live playback follow the same timing.
    param.setValueAtTime(1.0, t);
    param.linearRampToValueAtTime(KICK_808_DUCK_GAIN, t + KICK_808_DUCK_ATTACK_SEC);
    param.setValueAtTime(KICK_808_DUCK_GAIN, t + KICK_808_DUCK_ATTACK_SEC + KICK_808_DUCK_HOLD_SEC);
    param.setTargetAtTime(1.0, t + KICK_808_DUCK_ATTACK_SEC + KICK_808_DUCK_HOLD_SEC + 0.001, KICK_808_DUCK_RELEASE_SEC);
  }

  private triggerInstrumentEvent(
    ctx: BaseAudioContext,
    trackId: BeatTrackId,
    time: number,
    velocity: number,
    midiNote: number,
    slide: boolean,
    slideTargetMidi?: number
  ) {
    if (!this.projectRef || !this.selected808) return;
    const strip = this.activeChannels[trackId];
    if (!strip) return;

    // Muted/solo-excluded tracks must not create sources or trigger sidechain
    // ducking. The channel gate alone silences audio but does not stop DSP work.
    if (!isChannelAudible(trackId, this.projectRef.mixer, this.monitorMode)) return;

    if (trackId === '808') {
      // Strictly monophonic 808 Cut-Itself so sub-bass notes never collide or mud up
      chokeVoiceAt(this.active808Voice, time, 0.012);
      const dest808 = this.active808Sidechain ?? strip.input;
      const project = this.projectRef;
      const tunedNote = snap808NoteToProjectScale(project, midiNote);
      const tunedSlideTarget = Number.isFinite(slideTargetMidi)
        ? snap808NoteToProjectScale(project, Number(slideTargetMidi))
        : undefined;
      const voice = trigger808Sound(
        ctx,
        dest808,
        this.selected808,
        this.active808Buffer,
        time,
        tunedNote,
        velocity,
        slide,
        tunedSlideTarget
      );
      this.active808Voice = voice;
      if (voice) {
        this.activeSources.add(voice.source);
        voice.source.onended = () => this.activeSources.delete(voice.source);
      }
      return;
    }

    if (trackId === 'hihat') {
      // Closed hi-hat chokes any ringing open hi-hat cleanly
      chokeVoiceAt(this.activeOpenHatVoice, time, 0.008);
      this.activeOpenHatVoice = null;
    }

    if (trackId === 'melody') {
      // Gentle voice-stealing fade so bells blend naturally without clicks
      chokeVoiceAt(this.activeMelodyVoice, time, 0.055);
    }

    const voice = triggerKitSample(
      ctx,
      strip.input,
      trackId,
      this.kitBuffers[trackId],
      time,
      velocity,
      midiNote
    );

    // Duck the 808 only when a kick sample was actually started. A missing or
    // undecodable kick sample must never create an audible hole in the bass.
    if (trackId === 'kick' && voice) {
      this.applySidechainDuck(this.active808Sidechain, time);
    }

    if (trackId === 'openhat') {
      chokeVoiceAt(this.activeOpenHatVoice, time, 0.01);
      this.activeOpenHatVoice = voice;
    } else if (trackId === 'melody') {
      this.activeMelodyVoice = voice;
    }

    if (voice) {
      this.activeSources.add(voice.source);
      voice.source.onended = () => this.activeSources.delete(voice.source);
    }
  }

  public stopPlayback() {
    this.playbackToken++;
    this.isPlaying = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.meterRaf !== null) {
      cancelAnimationFrame(this.meterRaf);
      this.meterRaf = null;
    }

    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.activeSources.clear();
    this.activeVocalSource = null;
    this.active808Voice = null;
    this.activeOpenHatVoice = null;
    this.activeMelodyVoice = null;

    if (this.active808Sidechain) {
      try {
        this.active808Sidechain.disconnect();
      } catch {
        // already disconnected
      }
      this.active808Sidechain = null;
    }

    if (this.activeMasterBus) {
      try {
        this.activeMasterBus.disconnect();
      } catch {
        // already disconnected
      }
      this.activeMasterBus = null;
    }
    this.activeChannels = {};
  }

  public async exportToWav(params: {
    project: TrapProject;
    vocalBuffer: AudioBuffer | null;
    selected808: Sample808;
    active808Buffer: AudioBuffer | null;
    exportMode: MonitorMode;
    bitDepth?: 16 | 24;
    sampleRate?: 44100 | 48000;
    soloTrack?: ExportTrackId | null;
  }): Promise<Blob> {
    const { project, vocalBuffer, selected808, active808Buffer, exportMode, bitDepth = 16, sampleRate = 44100, soloTrack = null } = params;
    // Load only tracks that are audible and contain events in this render.
    // A vocal-only export therefore remains independent of drum-kit downloads.
    const requiredKitTracks = getRequiredKitTracks(project, exportMode, soloTrack);
    const kit: Partial<Record<KitTrackId, AudioBuffer>> = requiredKitTracks.length > 0
      ? await this.ensureKitBuffers(requiredKitTracks)
      : {};
    const sr: 44100 | 48000 = sampleRate === 48000 ? 48000 : 44100;
    const pat = project.beatPattern ?? { stepsCount: 16, swing: 0, tracks: {}, mouthEvents: [], useExactMouthTiming: false } as TrapProject['beatPattern'];
    // Projects can come from older saves or imported JSON. Sanitize timing
    // before creating OfflineAudioContext; NaN/Infinity can otherwise cause
    // a RangeError or an unexpectedly huge render allocation.
    const bpm = Number.isFinite(project.bpm) ? Math.max(40, Math.min(240, project.bpm)) : 140;
    const stepsCount = Number.isFinite(pat.stepsCount)
      ? Math.max(1, Math.min(64, Math.floor(pat.stepsCount)))
      : 16;
    const swing = Number.isFinite(pat.swing) ? Math.max(0, Math.min(0.75, pat.swing)) : 0;
    const stepDur = 60 / bpm / 4;
    const loopDur = stepDur * stepsCount;

    const vocalDuration = vocalBuffer && Number.isFinite(vocalBuffer.duration)
      ? Math.max(0, vocalBuffer.duration)
      : 0;
    const mouthEvents = pat.useExactMouthTiming ? getOrderedMouthEvents(project) : [];
    // Exact beatbox timing can extend beyond the normal 1–4 bar grid. Make
    // the render long enough to include the complete mouth pattern instead
    // of silently truncating late events at the default 8-second beat export.
    const mouthLoopDuration = mouthEvents.length > 0
      ? getMouthLoopLength(mouthEvents, loopDur, stepDur)
      : loopDur;
    const minBeatDur = Math.max(loopDur * 2, mouthLoopDuration * 2, 8);
    const totalDuration = vocalBuffer
      ? Math.max(vocalDuration + 1.2, loopDur, mouthLoopDuration)
      : minBeatDur;
    // Keep offline rendering within a practical memory budget on phones.
    // A 15-minute stereo 44.1 kHz float render needs roughly 318 MB
    // for the AudioBuffer alone, so reject longer exports with a clear error.
    const MAX_EXPORT_SECONDS = 15 * 60;
    if (!Number.isFinite(totalDuration) || totalDuration <= 0 || totalDuration > MAX_EXPORT_SECONDS) {
      throw new Error('A exportação deve ter uma duração válida e não pode ultrapassar 15 minutos.');
    }

    const offline = new OfflineAudioContext(2, Math.ceil(totalDuration * sr), sr);

    const master = project.master ?? { outputGain: 0.9, clipperDrive: 0.25, limiterEnabled: true };
    const outputGain = Number.isFinite(master.outputGain)
      ? Math.max(0, Math.min(1.5, master.outputGain)) : 0.9;
    const clipperDrive = Number.isFinite(master.clipperDrive)
      ? Math.max(0, Math.min(1, master.clipperDrive)) : 0.25;
    const masterBus = offline.createGain();
    masterBus.gain.value = outputGain * 0.88;

    const clipper = createMasterClipper(offline, clipperDrive);

    const limiter = offline.createDynamicsCompressor();
    limiter.threshold.value = master.limiterEnabled ? -2.0 : 0;
    limiter.knee.value = master.limiterEnabled ? 2 : 4;
    limiter.ratio.value = master.limiterEnabled ? 12 : 1;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;

    masterBus.connect(clipper);
    clipper.connect(limiter);
    limiter.connect(offline.destination);

    if (vocalBuffer && isChannelAudible('vocal', project.mixer, exportMode, soloTrack)) {
      const processedVocal = processVocalWithAutotune(offline, vocalBuffer, project.autotune);
      const vocalStrip = buildChannelChain(offline, project.mixer.vocal, masterBus, true);

      const vocalRumbleFilter = createVocalRumbleFilter(offline);
      const preGain = offline.createGain();
      const fx = project.vocalFx ?? { gainDb: 0, compression: 0.35, deEsser: 0, reverb: 0, delay: 0, offsetMs: 0 };
      const fxNumber = (value: number, fallback: number, min: number, max: number) =>
        Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
      const gainDb = fxNumber(fx.gainDb, 0, -24, 24);
      const compression = fxNumber(fx.compression, 0.35, 0, 1);
      const deEsserAmount = fxNumber(fx.deEsser, 0, 0, 1);
      const reverbAmount = fxNumber(fx.reverb, 0, 0, 1);
      const delayAmount = fxNumber(fx.delay, 0, 0, 1);
      const offsetMs = fxNumber(fx.offsetMs, 0, -200, 200);
      preGain.gain.value = Math.pow(10, gainDb / 20);
      const comp = offline.createDynamicsCompressor();
      comp.threshold.value = -24 + (1 - compression) * 18;
      comp.ratio.value = 1 + compression * 7;

      const deEsser = offline.createBiquadFilter();
      deEsser.type = 'peaking';
      deEsser.frequency.value = 6800;
      deEsser.gain.value = -deEsserAmount * 9;

      const dryGain = offline.createGain();
      dryGain.gain.value = 1;
      const revGain = offline.createGain();
      revGain.gain.value = reverbAmount * 0.65;
      const conv = offline.createConvolver();
      conv.buffer = createSimpleImpulse(offline, 1.35, 2.8);

      const delayNode = offline.createDelay(1.0);
      delayNode.delayTime.value = Math.min(0.8, 60 / bpm / 2);
      const delayFb = offline.createGain();
      delayFb.gain.value = 0.28;
      const delayMix = offline.createGain();
      delayMix.gain.value = delayAmount * 0.45;

      preGain.connect(deEsser);
      deEsser.connect(comp);
      comp.connect(dryGain);
      dryGain.connect(vocalStrip.input);
      comp.connect(conv);
      conv.connect(revGain);
      revGain.connect(vocalStrip.input);
      comp.connect(delayNode);
      delayNode.connect(delayFb);
      delayFb.connect(delayNode);
      delayNode.connect(delayMix);
      delayMix.connect(vocalStrip.input);

      const vSrc = offline.createBufferSource();
      vSrc.buffer = processedVocal;
      vSrc.connect(vocalRumbleFilter);
      vocalRumbleFilter.connect(preGain);
      const offsetSec = offsetMs / 1000;
      if (offsetSec >= 0) {
        vSrc.start(offsetSec);
      } else {
        vSrc.start(0, Math.min(processedVocal.duration, Math.abs(offsetSec)));
      }
    }

    const trackIds: BeatTrackId[] = [
      '808',
      'kick',
      'snare',
      'clap',
      'hihat',
      'openhat',
      'perc',
      'melody',
    ];
    const channelNodes: Partial<Record<BeatTrackId, GainNode>> = {};
    let offline808MaskFilter: BiquadFilterNode | null = null;
    for (const tr of trackIds) {
      if (isChannelAudible(tr, project.mixer, exportMode, soloTrack)) {
        const strip = buildChannelChain(offline, project.mixer[tr], masterBus, true, tr === '808');
        channelNodes[tr] = strip.input;
        if (tr === '808') offline808MaskFilter = strip.dynamicLowMid;
      }
    }
    const rawOfflineVocalOffsetMs = project.vocalFx?.offsetMs ?? 0;
    const offlineVocalOffsetSec = (Number.isFinite(rawOfflineVocalOffsetMs) ? Math.max(-200, Math.min(200, rawOfflineVocalOffsetMs)) : 0) / 1000;
    scheduleVocalMasking(
      isChannelAudible('vocal', project.mixer, exportMode, soloTrack) ? offline808MaskFilter : null,
      vocalBuffer,
      Math.max(0, offlineVocalOffsetSec),
      Math.max(0, -offlineVocalOffsetSec)
    );

    let offlineSidechain808: GainNode | null = null;
    if (channelNodes['808']) {
      offlineSidechain808 = offline.createGain();
      offlineSidechain808.gain.value = 1;
      offlineSidechain808.connect(channelNodes['808']);
    }

    let offline808Voice: TriggeredVoice | null = null;
    let offlineOpenHatVoice: TriggeredVoice | null = null;
    let offlineMelodyVoice: TriggeredVoice | null = null;

    const triggerOffline = (
      tr: BeatTrackId,
      t: number,
      velocity: number,
      note: number,
      slide: boolean,
      slideTargetMidi?: number
    ) => {
      const dest = channelNodes[tr];
      if (!dest) return;
      if (tr === '808') {
        chokeVoiceAt(offline808Voice, t, 0.012);
        const tunedNote = snap808NoteToProjectScale(project, note);
        const tunedSlideTarget = Number.isFinite(slideTargetMidi)
          ? snap808NoteToProjectScale(project, Number(slideTargetMidi))
          : undefined;
        offline808Voice = trigger808Sound(
          offline,
          offlineSidechain808 ?? dest,
          selected808,
          active808Buffer,
          t,
          tunedNote,
          velocity,
          slide,
          tunedSlideTarget
        );
        return;
      }
      if (tr === 'hihat') {
        chokeVoiceAt(offlineOpenHatVoice, t, 0.008);
        offlineOpenHatVoice = null;
      }
      if (tr === 'melody') {
        chokeVoiceAt(offlineMelodyVoice, t, 0.055);
      }
      const v = triggerKitSample(offline, dest, tr, kit[tr], t, velocity, note);
      // Match live playback: only duck when the offline kick sample exists and starts.
      if (tr === 'kick' && v) {
        this.applySidechainDuck(offlineSidechain808, t);
      }
      if (tr === 'openhat') {
        chokeVoiceAt(offlineOpenHatVoice, t, 0.01);
        offlineOpenHatVoice = v;
      } else if (tr === 'melody') {
        offlineMelodyVoice = v;
      }
    };

    if (mouthEvents.length > 0) {
      const mLoopLen = getMouthLoopLength(mouthEvents, loopDur, stepDur);
      let cycleStart = 0;
      while (cycleStart < totalDuration - 0.1) {
        for (const ev of mouthEvents) {
          const t = cycleStart + ev.timeSec;
          if (t >= totalDuration - 0.1) break;
          triggerOffline(
            ev.instrument,
            t,
            ev.velocity,
            ev.note ?? (ev.instrument === '808' ? selected808.rootNote : 60),
            false
          );
        }
        cycleStart += mLoopLen;
      }
    } else {
      const totalSteps = Math.floor((totalDuration - 0.05) / stepDur);
      for (let s = 0; s < totalSteps; s++) {
        const stepIdx = s % stepsCount;
        const swingOffset = stepIdx % 2 === 1 ? swing * stepDur : 0;
        const baseT = s * stepDur;

        for (const tr of trackIds) {
          if (tr === 'melody' && !project.directionConstraints.allowMelodies) continue;
          const step = pat.tracks?.[tr]?.[stepIdx];
          if (!step || !step.active) continue;

          const t = tr === 'hihat' || tr === 'perc' ? baseT + swingOffset : baseT;
          const rolls = Number.isFinite(step.roll) && step.roll > 1 ? Math.min(8, Math.floor(step.roll)) : 1;
          for (let r = 0; r < rolls; r++) {
            const rTime = t + (r * stepDur) / rolls;
            const rollVelScale = rolls > 1 ? 0.68 + (r / rolls) * 0.28 : 1;
            triggerOffline(
              tr,
              rTime,
              (Number.isFinite(step.velocity) ? Math.max(0, Math.min(1, step.velocity)) : 0.85) * rollVelScale,
              step.note ?? (tr === '808' ? selected808.rootNote : 60),
              Boolean(step.slide),
              tr === '808' && step.slide
                ? getNext808SlideNote(project, stepIdx, step.note ?? selected808.rootNote)
                : undefined
            );
          }
        }
      }
    }

    const rendered = await offline.startRendering();
    return audioBufferToStereoWavBlob(rendered, bitDepth);
  }
}

function audioBufferToStereoWavBlob(buffer: AudioBuffer, bitDepth: 16 | 24 = 16): Blob {
  const numChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const length = buffer.length;
  const sampleRate = Math.round(buffer.sampleRate);
  const bytesPerSample = bitDepth === 24 ? 3 : 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;

  // Classic RIFF/WAV stores chunk sizes in unsigned 32-bit fields.
  // Reject invalid buffers before allocating a potentially large output.
  if (!Number.isSafeInteger(length) || length <= 0 ||
      !Number.isSafeInteger(dataSize) || dataSize < 0 || dataSize > 0xffffffff - 36) {
    throw new Error('O áudio é demasiado grande ou tem uma duração inválida para exportar em WAV.');
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error('A frequência de amostragem do áudio é inválida.');
  }

  const channels = Array.from({ length: numChannels }, (_, channel) => buffer.getChannelData(channel));
  if (channels.some((channel) => channel.length !== length)) {
    throw new Error('Os canais do áudio têm durações diferentes e não podem ser exportados.');
  }

  // Preserve the mix dynamics: only attenuate when the rendered sample peak
  // exceeds -1 dBFS. Never auto-boost quiet mixes. This avoids hard-clipping
  // the PCM conversion at the last moment and leaves a little delivery headroom.
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      const sample = channel[i];
      if (Number.isFinite(sample)) peak = Math.max(peak, Math.abs(sample));
    }
  }
  const ceiling = Math.pow(10, -1 / 20);
  const peakGuardGain = peak > ceiling ? ceiling / peak : 1;

  const wavBuf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuf);
  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Deterministic TPDF dither (one-LSB peak-to-peak distribution) reduces
  // quantization distortion when converting the float render to 16-bit PCM.
  let randomState = (length ^ (sampleRate << 7) ^ 0x6d2b79f5) >>> 0;
  const randomUnit = (): number => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x100000000;
  };
  const quantize = (sample: number): number => {
    const finiteSample = Number.isFinite(sample) ? sample : 0;
    const scale = bitDepth === 24 ? 8388608 : 32768;
    const min = -scale;
    const max = scale - 1;
    // TPDF dither at one-LSB scale, applied immediately before quantization.
    const scaled = finiteSample * peakGuardGain * scale + (randomUnit() - randomUnit());
    return Math.max(min, Math.min(max, Math.round(scaled)));
  };

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const pcm = quantize(channels[channel][i]);
      if (bitDepth === 16) {
        view.setInt16(offset, pcm, true);
        offset += 2;
      } else {
        // PCM 24-bit is signed two's-complement, little-endian, packed in 3 bytes.
        view.setUint8(offset, pcm & 0xff);
        view.setUint8(offset + 1, (pcm >> 8) & 0xff);
        view.setUint8(offset + 2, (pcm >> 16) & 0xff);
        offset += 3;
      }
    }
  }

  return new Blob([wavBuf], { type: 'audio/wav' });
}
