import React from 'react';
import { Activity, Loader2, Sliders, Sparkles, Volume2 } from 'lucide-react';
import {
  AutotuneSettings,
  DspVocalMetrics,
  MusicalKey,
  MusicalScale,
  VocalAnalysisResult,
  VocalFxSettings,
} from '../types/studio';
import { WaveformRecorder } from './WaveformRecorder';

const KEYS: MusicalKey[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SCALES: Array<{ id: MusicalScale; label: string }> = [
  { id: 'minor', label: 'Menor Natural' },
  { id: 'harmonic_minor', label: 'Menor Harmónica' },
  { id: 'phrygian', label: 'Frígia (Trap Sombrio)' },
  { id: 'dorian', label: 'Dórica' },
  { id: 'major', label: 'Maior' },
  { id: 'chromatic', label: 'Cromática (Todas)' },
];

interface VocalAndAutotunePanelProps {
  vocalBuffer: AudioBuffer | null;
  vocalFileName: string | null;
  vocalDsp: DspVocalMetrics | null;
  vocalAnalysis: VocalAnalysisResult | null;
  isAnalyzing: boolean;
  analyzeError: string | null;
  autotune: AutotuneSettings;
  vocalFx: VocalFxSettings;
  onRecordedVocal: (blob: Blob, durationSec: number) => Promise<void>;
  onImportVocal: (file: File) => Promise<void>;
  onAnalyzeVocal: () => Promise<void>;
  onApplyDetectedTiming: (bpm: number, key: MusicalKey, scale: MusicalScale) => void;
  onChangeAutotune: (next: AutotuneSettings) => void;
  onChangeVocalFx: (next: VocalFxSettings) => void;
}

export const VocalAndAutotunePanel: React.FC<VocalAndAutotunePanelProps> = ({
  vocalBuffer,
  vocalFileName,
  vocalDsp,
  vocalAnalysis,
  isAnalyzing,
  analyzeError,
  autotune,
  vocalFx,
  onRecordedVocal,
  onImportVocal,
  onAnalyzeVocal,
  onApplyDetectedTiming,
  onChangeAutotune,
  onChangeVocalFx,
}) => {
  return (
    <div className="space-y-5">
      {/* 1. Voice Recording & Import */}
      <WaveformRecorder
        title="Gravação da Voz Principal"
        subtitle={
          vocalFileName
            ? `Áudio carregado: ${vocalFileName}`
            : 'Cante ou faça o seu flow diretamente. A sua voz, pausas e ritmo originais são sempre preservados.'
        }
        recordLabel="Gravar Voz"
        stopLabel="Parar Gravação"
        importLabel="Importar Voz"
        audioBuffer={vocalBuffer}
        pauses={vocalDsp?.pauses}
        entriesSec={vocalDsp?.entryTimestampsSec}
        onRecordedBlob={onRecordedVocal}
        onImportFile={onImportVocal}
      />

      {/* 2. Real DSP + AI Vocal Analysis */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Análise da Voz e Cadência
            </h3>
            <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">
              Mede entradas, pausas, intensidade, BPM e tonalidade sem alterar a gravação.
            </p>
          </div>
          <button
            type="button"
            disabled={!vocalBuffer || isAnalyzing}
            onClick={onAnalyzeVocal}
            className="min-h-[46px] px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#0A0B0E] font-semibold text-sm flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
          >
            {isAnalyzing ? (
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            ) : (
              <Sparkles className="w-4 h-4 shrink-0" />
            )}
            <span>{isAnalyzing ? 'A analisar voz...' : 'Analisar Voz com IA'}</span>
          </button>
        </div>

        {analyzeError && (
          <div className="text-xs sm:text-sm text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3.5 py-2.5">
            {analyzeError}
          </div>
        )}

        {vocalDsp ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-[#0D0F14] border border-[#222733] rounded-xl p-3">
                <div className="text-xs text-[#949CAE]">BPM Medido</div>
                <div className="text-lg font-bold font-mono-tabular text-[#F4F4F6] mt-0.5">
                  {vocalAnalysis?.bpm ?? vocalDsp.estimatedBpm} BPM
                </div>
              </div>
              <div className="bg-[#0D0F14] border border-[#222733] rounded-xl p-3">
                <div className="text-xs text-[#949CAE]">Tonalidade</div>
                <div className="text-lg font-bold font-mono-tabular text-amber-400 mt-0.5">
                  {vocalAnalysis?.detectedKey ?? vocalDsp.detectedKey}{' '}
                  {(vocalAnalysis?.detectedScale ?? vocalDsp.detectedScale).replace('_', ' ')}
                </div>
              </div>
              <div className="bg-[#0D0F14] border border-[#222733] rounded-xl p-3">
                <div className="text-xs text-[#949CAE]">Entradas / Pausas</div>
                <div className="text-lg font-bold font-mono-tabular text-[#F4F4F6] mt-0.5">
                  {vocalDsp.entryTimestampsSec.length} / {vocalDsp.pauses.length}
                </div>
              </div>
              <div className="bg-[#0D0F14] border border-[#222733] rounded-xl p-3">
                <div className="text-xs text-[#949CAE]">Pico / Média dB</div>
                <div className="text-lg font-bold font-mono-tabular text-[#F4F4F6] mt-0.5">
                  {vocalDsp.rmsPeakDb} / {vocalDsp.rmsAvgDb}
                </div>
              </div>
            </div>

            {vocalAnalysis && (
              <div className="bg-[#0D0F14] border border-[#222733] rounded-xl p-3.5 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#949CAE]">
                  <span>Cadência: {vocalAnalysis.cadence}</span>
                  <span>Intensidade: {vocalAnalysis.intensityProfile}</span>
                </div>
                <p className="text-sm text-[#E2E6EE] leading-relaxed">{vocalAnalysis.summaryPt}</p>
                <button
                  type="button"
                  onClick={() =>
                    onApplyDetectedTiming(
                      vocalAnalysis.bpm,
                      vocalAnalysis.detectedKey,
                      vocalAnalysis.detectedScale
                    )
                  }
                  className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#1A1D26] hover:bg-[#232734] border border-[#2E3444] text-amber-400 text-xs font-semibold cursor-pointer transition-colors"
                >
                  Aplicar BPM e Tom Detetados ao Projeto
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs sm:text-sm text-[#6B7385] py-2 flex items-center gap-2">
            <Activity className="w-4 h-4 shrink-0" />
            <span>Grave ou importe uma voz para ver a leitura de ritmo, pausas e tom.</span>
          </div>
        )}
      </div>

      {/* 3. Adjustable pitch correction; advanced formant preservation is not yet implemented. */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Autotune (Correção de Afinação)
            </h3>
            <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">
              Corrige a afinação na escala escolhida e mantém a duração da gravação. A preservação avançada do timbre ainda está em desenvolvimento.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChangeAutotune({ ...autotune, enabled: !autotune.enabled })}
            className={`min-h-[46px] px-4 py-2 rounded-xl font-semibold text-sm transition-colors cursor-pointer whitespace-nowrap ${
              autotune.enabled
                ? 'bg-amber-500 text-[#0A0B0E]'
                : 'bg-[#1A1D26] text-[#CBD2DF] border border-[#2D3342]'
            }`}
          >
            {autotune.enabled ? 'Autotune Ligado' : 'Autotune Desligado'}
          </button>
        </div>

        <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${!autotune.enabled ? 'opacity-50' : ''}`}>
          <div>
            <label className="block text-xs text-[#949CAE] mb-1.5">Nota Base (Tom)</label>
            <select
              value={autotune.key}
              onChange={(e) =>
                onChangeAutotune({ ...autotune, key: e.target.value as MusicalKey })
              }
              className="w-full min-h-[44px] bg-[#0D0F14] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
            >
              {KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-[#949CAE] mb-1.5">Escala Musical</label>
            <select
              value={autotune.scale}
              onChange={(e) =>
                onChangeAutotune({ ...autotune, scale: e.target.value as MusicalScale })
              }
              className="w-full min-h-[44px] bg-[#0D0F14] border border-[#252A36] rounded-xl px-3 text-sm text-[#F4F4F6]"
            >
              {SCALES.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Velocidade de Correção</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {autotune.retuneSpeedMs <= 5
                  ? `${autotune.retuneSpeedMs}ms (Trap Forte)`
                  : `${autotune.retuneSpeedMs}ms (Natural)`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={120}
              step={2}
              value={autotune.retuneSpeedMs}
              onChange={(e) =>
                onChangeAutotune({ ...autotune, retuneSpeedMs: Number(e.target.value) })
              }
              className="w-full studio-slider"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Intensidade (Mistura)</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {Math.round(autotune.mix * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={autotune.mix}
              onChange={(e) => onChangeAutotune({ ...autotune, mix: Number(e.target.value) })}
              className="w-full studio-slider"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Naturalidade (Humanize)</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {Math.round(autotune.humanize * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={autotune.humanize}
              onChange={(e) => onChangeAutotune({ ...autotune, humanize: Number(e.target.value) })}
              className="w-full studio-slider"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Sincronia Voz vs Beat</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {vocalFx.offsetMs > 0 ? `+${vocalFx.offsetMs}ms` : `${vocalFx.offsetMs}ms`}
              </span>
            </div>
            <input
              type="range"
              min={-200}
              max={200}
              step={5}
              value={vocalFx.offsetMs}
              onChange={(e) =>
                onChangeVocalFx({ ...vocalFx, offsetMs: Number(e.target.value) })
              }
              className="w-full studio-slider"
            />
          </div>
        </div>
      </div>

      {/* 4. Quick Vocal Polish Rack */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-amber-400" />
          <h3 className="text-base font-semibold text-[#F4F4F6]">
            Tratamento Rápido da Voz
          </h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE] flex items-center gap-1">
                <Volume2 className="w-3.5 h-3.5" /> Ganho
              </span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {vocalFx.gainDb > 0 ? `+${vocalFx.gainDb}` : vocalFx.gainDb} dB
              </span>
            </div>
            <input
              type="range"
              min={-12}
              max={12}
              step={0.5}
              value={vocalFx.gainDb}
              onChange={(e) => onChangeVocalFx({ ...vocalFx, gainDb: Number(e.target.value) })}
              className="w-full studio-slider"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Compressão</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {Math.round(vocalFx.compression * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={vocalFx.compression}
              onChange={(e) =>
                onChangeVocalFx({ ...vocalFx, compression: Number(e.target.value) })
              }
              className="w-full studio-slider"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Reverb (Espaço)</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {Math.round(vocalFx.reverb * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={vocalFx.reverb}
              onChange={(e) => onChangeVocalFx({ ...vocalFx, reverb: Number(e.target.value) })}
              className="w-full studio-slider"
            />
          </div>
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Delay (Eco)</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {Math.round(vocalFx.delay * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={vocalFx.delay}
              onChange={(e) => onChangeVocalFx({ ...vocalFx, delay: Number(e.target.value) })}
              className="w-full studio-slider"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
