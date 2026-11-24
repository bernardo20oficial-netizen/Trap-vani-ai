import React, { useState } from 'react';
import {
  Drum,
  Loader2,
  Mic,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  BeatDirectionConstraints,
  BeatPattern,
  BeatTrackId,
  StudioMode,
} from '../types/studio';
import { TRAP_STYLE_PRESETS, TrapStylePresetId } from '../audio/trapArranger';
import { WaveformRecorder } from './WaveformRecorder';

interface BeatStudioPanelProps {
  mode: StudioMode;
  bpm: number;
  currentStep: number;
  isPlaying: boolean;
  mouthBuffer: AudioBuffer | null;
  mouthBusy: boolean;
  mouthError: string | null;
  directionPrompt: string;
  constraints: BeatDirectionConstraints;
  directionBusy: boolean;
  directionError: string | null;
  beatPattern: BeatPattern;
  beatBusy: boolean;
  beatError: string | null;
  onChangeBpm: (bpm: number) => void;
  onRecordedMouth: (blob: Blob, durationSec: number) => Promise<void>;
  onImportMouth: (file: File) => Promise<void>;
  onConvertMouthToBeat: () => Promise<void>;
  onToggleExactMouthTiming: () => void;
  onChangeDirectionPrompt: (text: string) => void;
  onApplyDirection: (instructionText?: string) => Promise<void>;
  onClearDirection: () => void;
  onGenerateBeat: (scope: 'all' | 'drums' | 'hihat' | '808' | 'melody') => Promise<void>;
  onApplyPresetBeat: (presetId: TrapStylePresetId) => void;
  onRemoveMelodies: () => void;
  onUpdatePattern: (next: BeatPattern) => void;
}

const TRACK_META: Array<{ id: BeatTrackId; label: string }> = [
  { id: '808', label: '808 Bass' },
  { id: 'kick', label: 'Kick' },
  { id: 'snare', label: 'Snare' },
  { id: 'clap', label: 'Clap' },
  { id: 'hihat', label: 'Hi-Hat' },
  { id: 'openhat', label: 'Open Hat' },
  { id: 'perc', label: 'Perc' },
  { id: 'melody', label: 'Melodia' },
];

const QUICK_DIRECTIONS = [
  'Quero que a música não seja melódica',
  'Quero um beat agressivo e sombrio',
  'Quero mais 808 e menos instrumentos',
  'Não quero piano nem melodias, apenas bateria, baixo e 808',
  'Quero um beat pesado, com bateria explosiva',
];

export const BeatStudioPanel: React.FC<BeatStudioPanelProps> = ({
  mode,
  bpm,
  currentStep,
  isPlaying,
  mouthBuffer,
  mouthBusy,
  mouthError,
  directionPrompt,
  constraints,
  directionBusy,
  directionError,
  beatPattern,
  beatBusy,
  beatError,
  onChangeBpm,
  onRecordedMouth,
  onImportMouth,
  onConvertMouthToBeat,
  onToggleExactMouthTiming,
  onChangeDirectionPrompt,
  onApplyDirection,
  onClearDirection,
  onGenerateBeat,
  onApplyPresetBeat,
  onRemoveMelodies,
  onUpdatePattern,
}) => {
  const [selectedToolRoll, setSelectedToolRoll] = useState<1 | 2 | 3 | 4>(1);
  const [selectedSlide808, setSelectedSlide808] = useState(false);
  const [barPage, setBarPage] = useState<0 | 1>(0);
  const [followPlayhead, setFollowPlayhead] = useState(true);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceSpeechError, setVoiceSpeechError] = useState<string | null>(null);
  const [showSeqInAuto, setShowSeqInAuto] = useState(false);

  const is64 = beatPattern.stepsCount === 64;
  const activePlayheadPage: 0 | 1 = currentStep >= 32 ? 1 : 0;
  const visiblePage: 0 | 1 = is64 ? (isPlaying && followPlayhead ? activePlayheadPage : barPage) : 0;
  const pageOffset = visiblePage * 32;

  const toggleStep = (trackId: BeatTrackId, stepIdx: number) => {
    const nextTracks = { ...beatPattern.tracks };
    const existingRow = nextTracks[trackId] || [];
    const row = Array.from({ length: beatPattern.stepsCount }, (_, idx) => {
      return existingRow[idx] ?? { active: false, velocity: 0.85 };
    });
    const curr = row[stepIdx];
    row[stepIdx] = {
      ...curr,
      active: !curr.active,
      velocity: curr.velocity || 0.88,
      roll: trackId === 'hihat' ? selectedToolRoll : 1,
      slide: trackId === '808' ? selectedSlide808 : false,
      note: curr.note ?? (trackId === '808' ? 36 : 60),
    };
    nextTracks[trackId] = row;
    onUpdatePattern({
      ...beatPattern,
      tracks: nextTracks,
      useExactMouthTiming: false,
      createdFrom: 'manual',
    });
  };

  const handleVoiceInstruction = () => {
    setVoiceSpeechError(null);
    const SpeechRec =
      (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition;

    if (!SpeechRec) {
      setVoiceSpeechError(
        'Ditado por voz direto não disponível neste navegador. Escreva a instrução abaixo.'
      );
      return;
    }

    const rec = new SpeechRec() as {
      lang: string;
      interimResults: boolean;
      maxAlternatives: number;
      onresult: (ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onerror: (ev: { error: string }) => void;
      onend: () => void;
      start: () => void;
    };

    rec.lang = 'pt-PT';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setVoiceListening(true);

    rec.onresult = (ev) => {
      const spoken = ev.results?.[0]?.[0]?.transcript || '';
      if (spoken) {
        onChangeDirectionPrompt(spoken);
        void onApplyDirection(spoken);
      }
    };
    rec.onerror = (ev) => {
      setVoiceSpeechError(`Erro no reconhecimento de voz: ${ev.error}`);
      setVoiceListening(false);
    };
    rec.onend = () => setVoiceListening(false);
    rec.start();
  };

  return (
    <div className="space-y-5">
      {/* 1. Mouth-to-Beat Section */}
      <div className="space-y-3">
        <WaveformRecorder
          title="Criar Beat com a Boca"
          subtitle="Faça o ritmo com a boca (ex: bum, bum, tchá, dum, pá, tchá). A IA converte em bateria e 808 respeitando o seu ritmo e pausas."
          recordLabel="Gravar Beat com a Boca"
          stopLabel="Parar Beat da Boca"
          importLabel="Importar Beatbox"
          audioBuffer={mouthBuffer}
          onRecordedBlob={onRecordedMouth}
          onImportFile={onImportMouth}
          compact
        />

        <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-medium text-[#F4F4F6]">
              {beatPattern.mouthEvents.length > 0
                ? `${beatPattern.mouthEvents.length} batidas detetadas da sua boca`
                : 'Grave o padrão com a boca para converter em instrumentos reais'}
            </div>
            {beatPattern.mouthEvents.length > 0 && (
              <button
                type="button"
                onClick={onToggleExactMouthTiming}
                className="text-xs font-medium text-amber-400 hover:underline cursor-pointer"
              >
                {beatPattern.useExactMouthTiming
                  ? `Modo Ativo: Ritmo Exato da Boca (clique para mudar para Grelha ${beatPattern.stepsCount} passos)`
                  : `Modo Ativo: Grelha ${beatPattern.stepsCount} Passos (clique para usar Ritmo Exato da Boca)`}
              </button>
            )}
          </div>

          <button
            type="button"
            disabled={!mouthBuffer || mouthBusy}
            onClick={onConvertMouthToBeat}
            className="min-h-[48px] px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#0A0B0E] font-semibold text-sm flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
          >
            {mouthBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Drum className="w-4 h-4" />
            )}
            <span>{mouthBusy ? 'A converter beat...' : 'Transformar Boca em Beat'}</span>
          </button>
        </div>

        {mouthError && (
          <div className="text-xs sm:text-sm text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3.5 py-2.5">
            {mouthError}
          </div>
        )}
      </div>

      {/* 2. Optional Natural Language Portuguese Directions */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Direção do Beat em Português (Opcional)
            </h3>
            <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">
              Diga ou escreva o que quer ou não quer. Se deixar vazio, a IA não inventa alterações desnecessárias.
            </p>
          </div>
          {constraints.rawPrompt && (
            <button
              type="button"
              onClick={onClearDirection}
              className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#1A1D26] hover:bg-[#232734] text-xs text-[#CBD2DF] flex items-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Limpar Regra</span>
            </button>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-2.5">
          <textarea
            rows={2}
            value={directionPrompt}
            onChange={(e) => onChangeDirectionPrompt(e.target.value)}
            placeholder="Ex: Quero que a música não seja melódica, quero mais 808 e bateria pesada..."
            className="flex-1 bg-[#0D0F14] border border-[#252A36] focus:border-amber-500 outline-none rounded-xl p-3 text-sm text-[#F4F4F6] placeholder:text-[#5F6778] resize-none"
          />
          <div className="flex sm:flex-col gap-2">
            <button
              type="button"
              disabled={directionBusy || !directionPrompt.trim()}
              onClick={() => onApplyDirection()}
              className="flex-1 min-h-[46px] px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#0A0B0E] font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
            >
              {directionBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Zap className="w-4 h-4" />
              )}
              <span>Interpretar</span>
            </button>

            <button
              type="button"
              onClick={handleVoiceInstruction}
              className={`min-h-[46px] px-4 py-2 rounded-xl border text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap ${
                voiceListening
                  ? 'bg-red-600 border-red-500 text-white'
                  : 'bg-[#1A1D26] hover:bg-[#232734] border-[#2D3342] text-[#E2E6EE]'
              }`}
            >
              <Mic className="w-4 h-4" />
              <span>{voiceListening ? 'A ouvir...' : 'Falar'}</span>
            </button>
          </div>
        </div>

        {/* Clickable quick-direction examples */}
        <div className="flex flex-wrap gap-2">
          {QUICK_DIRECTIONS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                onChangeDirectionPrompt(preset);
                void onApplyDirection(preset);
              }}
              className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#0D0F14] hover:bg-[#1B1F2A] border border-[#232836] text-xs text-[#CBD2DF] text-left transition-colors cursor-pointer"
            >
              {preset}
            </button>
          ))}
        </div>

        {(directionError || voiceSpeechError) && (
          <div className="text-xs sm:text-sm text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3.5 py-2.5">
            {directionError || voiceSpeechError}
          </div>
        )}

        {/* Active Constraint Summary */}
        <div className="bg-[#0D0F14] border border-[#222733] rounded-xl p-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#CBD2DF]">
          <div>
            <span className="text-[#949CAE]">Regras Ativas: </span>
            <span>{constraints.summaryPt}</span>
          </div>
          <div className="font-mono-tabular text-[#949CAE]">
            Melodias: {constraints.allowMelodies ? 'Permitidas' : 'Bloqueadas'} · Mood:{' '}
            {constraints.mood} · 808: {constraints.sub808Intensity}
          </div>
        </div>
      </div>

      {/* 3. Beat Generation & Partial Alteration (Without Re-recording Voice) */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Gerar e Alterar Beat (Sem Regravar a Voz)
            </h3>
            <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">
              {beatPattern.descriptionPt}
            </p>
          </div>
          <div className="flex items-center gap-2 bg-[#0D0F14] border border-[#252A36] rounded-xl px-3 py-1.5">
            <span className="text-xs text-[#949CAE]">BPM</span>
            <input
              type="number"
              min={70}
              max={180}
              value={bpm}
              onChange={(e) => onChangeBpm(Math.max(70, Math.min(180, Number(e.target.value) || 130)))}
              className="w-16 bg-transparent font-mono-tabular text-sm font-bold text-amber-400 outline-none text-right"
            />
          </div>
        </div>

        {beatError && (
          <div className="text-xs sm:text-sm text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3.5 py-2.5">
            {beatError}
          </div>
        )}

        {/* Curated 4-Bar Studio Trap Styles (Key & Scale Locked) */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-[#949CAE]">
            Estruturas Trap de Estúdio (4 Compassos · Transpostas ao Tom do Projeto)
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {TRAP_STYLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onApplyPresetBeat(preset.id)}
                className="min-h-[42px] px-3 py-2 rounded-xl bg-[#0D0F14] hover:bg-[#1B1F2A] border border-[#252A36] hover:border-amber-500/50 text-left transition-colors cursor-pointer"
              >
                <div className="text-xs font-semibold text-[#F4F4F6] truncate">{preset.label}</div>
                <div className="text-[11px] font-mono-tabular text-[#949CAE]">
                  {preset.defaultBpm} BPM · {preset.allowMelodies ? 'Com Melodia' : 'Sem Melodia'}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          <button
            type="button"
            disabled={beatBusy}
            onClick={() => onGenerateBeat('all')}
            className="min-h-[48px] px-4 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-45 text-[#0A0B0E] font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            {beatBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            <span>Gerar Novo Beat Completo</span>
          </button>

          <button
            type="button"
            disabled={beatBusy}
            onClick={() => onGenerateBeat('drums')}
            className="min-h-[48px] px-4 py-3 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-sm font-medium text-[#F4F4F6] flex items-center justify-center gap-2 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-amber-400" />
            <span>Alterar Só Bateria</span>
          </button>

          <button
            type="button"
            disabled={beatBusy}
            onClick={() => onGenerateBeat('hihat')}
            className="min-h-[48px] px-4 py-3 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-sm font-medium text-[#F4F4F6] flex items-center justify-center gap-2 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-amber-400" />
            <span>Alterar Só Hi-Hats</span>
          </button>

          <button
            type="button"
            disabled={beatBusy}
            onClick={() => onGenerateBeat('808')}
            className="min-h-[48px] px-4 py-3 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-sm font-medium text-[#F4F4F6] flex items-center justify-center gap-2 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-amber-400" />
            <span>Alterar Padrão de 808</span>
          </button>

          {constraints.allowMelodies && (
            <button
              type="button"
              disabled={beatBusy}
              onClick={() => onGenerateBeat('melody')}
              className="min-h-[48px] px-4 py-3 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-sm font-medium text-[#F4F4F6] flex items-center justify-center gap-2 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4 text-amber-400" />
              <span>Alterar Melodia</span>
            </button>
          )}

          <button
            type="button"
            onClick={onRemoveMelodies}
            className="min-h-[48px] px-4 py-3 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-sm font-medium text-[#CBD2DF] flex items-center justify-center gap-2 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            <span>Remover Melodias</span>
          </button>
        </div>
      </div>

      {/* 4. Pro Step Sequencer (Always open in Pro Mode, optional toggle in Auto Mode) */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-amber-400" />
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Sequenciador de {beatPattern.stepsCount} Passos ({is64 ? '4 Compassos' : '2 Compassos'})
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {is64 && (mode === 'pro' || showSeqInAuto) && (
              <div className="flex items-center p-1 bg-[#0D0F14] border border-[#222733] rounded-xl gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setFollowPlayhead(false);
                    setBarPage(0);
                  }}
                  className={`min-h-[34px] px-2.5 rounded-lg text-xs font-medium cursor-pointer flex items-center gap-1.5 ${
                    visiblePage === 0
                      ? 'bg-amber-500 text-[#0A0B0E] font-semibold'
                      : 'text-[#949CAE] hover:text-[#F4F4F6]'
                  }`}
                >
                  <span>Compassos 1–2</span>
                  {isPlaying && activePlayheadPage === 0 && visiblePage !== 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFollowPlayhead(false);
                    setBarPage(1);
                  }}
                  className={`min-h-[34px] px-2.5 rounded-lg text-xs font-medium cursor-pointer flex items-center gap-1.5 ${
                    visiblePage === 1
                      ? 'bg-amber-500 text-[#0A0B0E] font-semibold'
                      : 'text-[#949CAE] hover:text-[#F4F4F6]'
                  }`}
                >
                  <span>Compassos 3–4</span>
                  {isPlaying && activePlayheadPage === 1 && visiblePage !== 1 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setFollowPlayhead((v) => !v)}
                  className={`min-h-[34px] px-2.5 rounded-lg text-xs font-medium cursor-pointer ${
                    followPlayhead
                      ? 'bg-[#252B39] text-amber-300'
                      : 'text-[#949CAE] hover:text-[#F4F4F6]'
                  }`}
                >
                  Seguir
                </button>
              </div>
            )}

            {mode === 'auto' && (
              <button
                type="button"
                onClick={() => setShowSeqInAuto((v) => !v)}
                className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#1A1D26] border border-[#2D3342] text-xs font-medium text-[#E2E6EE] cursor-pointer"
              >
                {showSeqInAuto ? 'Ocultar Grelha' : 'Abrir Grelha Manual'}
              </button>
            )}
          </div>
        </div>

        {(mode === 'pro' || showSeqInAuto) && (
          <div className="space-y-4">
            {/* Step tools: Hi-Hat Roll, 808 Slide, Swing */}
            <div className="flex flex-wrap items-center gap-4 bg-[#0D0F14] border border-[#222733] rounded-xl p-3">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-[#949CAE] mr-1">Roll Hi-Hat:</span>
                {([1, 2, 3, 4] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setSelectedToolRoll(r)}
                    className={`min-h-[36px] min-w-[36px] px-2 rounded-lg text-xs font-mono-tabular font-semibold cursor-pointer ${
                      selectedToolRoll === r
                        ? 'bg-amber-500 text-[#0A0B0E]'
                        : 'bg-[#1A1D26] text-[#CBD2DF]'
                    }`}
                  >
                    {r}x
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setSelectedSlide808((v) => !v)}
                className={`min-h-[36px] px-3 rounded-lg text-xs font-medium cursor-pointer ${
                  selectedSlide808
                    ? 'bg-amber-500 text-[#0A0B0E] font-semibold'
                    : 'bg-[#1A1D26] text-[#CBD2DF]'
                }`}
              >
                Slide 808: {selectedSlide808 ? 'Ativo' : 'Normal'}
              </button>

              <div className="flex items-center gap-2 ml-auto min-w-[160px]">
                <span className="text-xs text-[#949CAE]">Swing</span>
                <input
                  type="range"
                  min={0}
                  max={0.28}
                  step={0.02}
                  value={beatPattern.swing}
                  onChange={(e) =>
                    onUpdatePattern({ ...beatPattern, swing: Number(e.target.value) })
                  }
                  className="flex-1 studio-slider"
                />
                <span className="text-xs font-mono-tabular text-[#F4F4F6] w-9 text-right">
                  {Math.round(beatPattern.swing * 100)}%
                </span>
              </div>
            </div>

            {/* Scrollable 32-step window (Bars 1-2 or Bars 3-4) with touch-friendly pads */}
            <div className="overflow-x-auto pb-2">
              <div className="min-w-[780px] space-y-2">
                {TRACK_META.map((tr) => {
                  if (tr.id === 'melody' && !constraints.allowMelodies) {
                    return null;
                  }
                  const rawRow = beatPattern.tracks[tr.id] || [];
                  const pageSteps = Array.from({ length: 32 }, (_, idx) => {
                    return rawRow[pageOffset + idx] ?? { active: false, velocity: 0.85 };
                  });
                  return (
                    <div key={tr.id} className="flex items-center gap-2">
                      <div className="w-24 shrink-0 text-xs font-medium text-[#CBD2DF] truncate">
                        {tr.label}
                      </div>
                      <div className="flex-1 grid grid-cols-32 gap-1">
                        {pageSteps.map((step, idx) => {
                          const realIdx = pageOffset + idx;
                          const isBeatDown = idx % 4 === 0;
                          const isPlayhead = isPlaying && currentStep === realIdx;
                          return (
                            <button
                              key={realIdx}
                              type="button"
                              onClick={() => toggleStep(tr.id, realIdx)}
                              aria-label={`${tr.label} passo ${realIdx + 1}`}
                              className={`h-9 rounded-md border transition-colors cursor-pointer relative ${
                                step.active
                                  ? 'bg-amber-500 border-amber-400 text-[#0A0B0E]'
                                  : isBeatDown
                                    ? 'bg-[#191D28] border-[#2C3344] hover:border-[#424C63]'
                                    : 'bg-[#0F1218] border-[#202532] hover:border-[#343C4F]'
                              } ${isPlayhead ? 'ring-2 ring-white/80' : ''}`}
                            >
                              {step.active && step.roll && step.roll > 1 && (
                                <span className="text-[9px] font-mono-tabular font-bold leading-none">
                                  {step.roll}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
