import React, { useState } from 'react';
import { Download, Headphones, Loader2, Sliders, Volume2 } from 'lucide-react';
import {
  BeatTrackId,
  ExportTrackId,
  MasterSettings,
  MixerChannels,
  MonitorMode,
  StudioMode,
  TrackMixSettings,
} from '../types/studio';

interface MixerAndExportPanelProps {
  mode: StudioMode;
  monitorMode: MonitorMode;
  mixer: MixerChannels;
  master: MasterSettings;
  allowMelodies: boolean;
  onChangeMonitorMode: (m: MonitorMode) => void;
  onChangeChannel: (ch: 'vocal' | BeatTrackId, next: TrackMixSettings) => void;
  onChangeMaster: (next: MasterSettings) => void;
  onExportWav: (exportMode: MonitorMode, bitDepth: 16 | 24, sampleRate: 44100 | 48000, soloTrack?: ExportTrackId | null) => Promise<void>;
  onExportAllStems: (bitDepth: 16 | 24, sampleRate: 44100 | 48000) => Promise<void>;
}

const CHANNELS: Array<{ id: 'vocal' | BeatTrackId; label: string }> = [
  { id: 'vocal', label: 'Voz Principal' },
  { id: '808', label: '808 Bass' },
  { id: 'kick', label: 'Kick' },
  { id: 'snare', label: 'Snare' },
  { id: 'clap', label: 'Clap' },
  { id: 'hihat', label: 'Hi-Hat' },
  { id: 'openhat', label: 'Open Hat' },
  { id: 'perc', label: 'Percussão' },
  { id: 'melody', label: 'Melodia' },
];

export const MixerAndExportPanel: React.FC<MixerAndExportPanelProps> = ({
  mode,
  monitorMode,
  mixer,
  master,
  allowMelodies,
  onChangeMonitorMode,
  onChangeChannel,
  onChangeMaster,
  onExportWav,
  onExportAllStems,
}) => {
  const [exportBusy, setExportBusy] = useState<MonitorMode | 'stem' | 'stemsZip' | null>(null);
  const [stemTrack, setStemTrack] = useState<ExportTrackId>('vocal');
  const [exportError, setExportError] = useState<string | null>(null);
  const [bitDepth, setBitDepth] = useState<16 | 24>(24);
  const [sampleRate, setSampleRate] = useState<44100 | 48000>(44100);

  const handleExport = async (m: MonitorMode, soloTrack: ExportTrackId | null = null) => {
    setExportError(null);
    setExportBusy(soloTrack ? 'stem' : m);
    try {
      await onExportWav(m, bitDepth, sampleRate, soloTrack);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Falha ao exportar WAV.');
    } finally {
      setExportBusy(null);
    }
  };

  const handleExportAllStems = async () => {
    setExportError(null);
    setExportBusy('stemsZip');
    try {
      await onExportAllStems(bitDepth, sampleRate);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Falha ao criar o pacote ZIP de pistas.');
    } finally {
      setExportBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* 1. Isolated Listening Switch (Voz / Beat / Completa) */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Headphones className="w-4 h-4 text-amber-400" />
          <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
            Escuta Isolada e Comparação
          </h3>
        </div>
        <p className="text-xs sm:text-sm text-[#949CAE]">
          Alterne instantaneamente entre a música completa, apenas a sua voz ou apenas o beat.
        </p>
        <div className="grid grid-cols-3 gap-2 bg-[#0D0F14] p-1.5 rounded-xl border border-[#222733]">
          {(
            [
              { id: 'full', label: 'Música Completa' },
              { id: 'vocal', label: 'Só Voz' },
              { id: 'beat', label: 'Só Beat' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onChangeMonitorMode(item.id)}
              className={`min-h-[44px] px-2.5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                monitorMode === item.id
                  ? 'bg-amber-500 text-[#0A0B0E]'
                  : 'text-[#CBD2DF] hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* 2. Channel Mixer & 3-Band EQ */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-amber-400" />
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Mesa de Mistura e Equalização
            </h3>
          </div>
          <span className="text-xs text-[#949CAE]">
            {mode === 'pro' ? 'Modo Profissional (EQ 3 Bandas + Pan)' : 'Volumes Rápidos'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {CHANNELS.map((ch) => {
            if (ch.id === 'melody' && !allowMelodies) return null;
            const s = mixer[ch.id];
            return (
              <div
                key={ch.id}
                className="bg-[#0D0F14] border border-[#222733] rounded-xl p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm text-[#F4F4F6]">{ch.label}</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onChangeChannel(ch.id, { ...s, mute: !s.mute })}
                      className={`min-h-[36px] min-w-[36px] px-2.5 rounded-lg text-xs font-bold cursor-pointer ${
                        s.mute
                          ? 'bg-red-600 text-white'
                          : 'bg-[#1A1D26] text-[#949CAE] border border-[#2D3342]'
                      }`}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeChannel(ch.id, { ...s, solo: !s.solo })}
                      className={`min-h-[36px] min-w-[36px] px-2.5 rounded-lg text-xs font-bold cursor-pointer ${
                        s.solo
                          ? 'bg-amber-500 text-[#0A0B0E]'
                          : 'bg-[#1A1D26] text-[#949CAE] border border-[#2D3342]'
                      }`}
                    >
                      S
                    </button>
                  </div>
                </div>

                {/* Volume Fader */}
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-[#949CAE] flex items-center gap-1">
                      <Volume2 className="w-3.5 h-3.5" /> Volume
                    </span>
                    <span className="font-mono-tabular text-[#F4F4F6]">
                      {Math.round(s.volume * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1.2}
                    step={0.02}
                    value={s.volume}
                    onChange={(e) =>
                      onChangeChannel(ch.id, { ...s, volume: Number(e.target.value) })
                    }
                    className="w-full studio-slider"
                  />
                </div>

                {/* Pro Controls: Pan + 3-Band EQ */}
                {mode === 'pro' && (
                  <div className="space-y-2 pt-2 border-t border-[#1C202B]">
                    <div>
                      <div className="flex justify-between text-[11px] text-[#949CAE]">
                        <span>Pan (Esq / Dir)</span>
                        <span className="font-mono-tabular">
                          {s.pan === 0
                            ? 'Centro'
                            : s.pan < 0
                              ? `E ${Math.abs(Math.round(s.pan * 100))}`
                              : `D ${Math.round(s.pan * 100)}`}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={-1}
                        max={1}
                        step={0.05}
                        value={s.pan}
                        onChange={(e) =>
                          onChangeChannel(ch.id, { ...s, pan: Number(e.target.value) })
                        }
                        className="w-full studio-slider"
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          { field: 'eqLow', label: 'Graves' },
                          { field: 'eqMid', label: 'Médios' },
                          { field: 'eqHigh', label: 'Agudos' },
                        ] as const
                      ).map((band) => (
                        <div key={band.field}>
                          <div className="text-[11px] text-[#949CAE] text-center">
                            {band.label}
                          </div>
                          <input
                            type="range"
                            min={-12}
                            max={12}
                            step={1}
                            value={s[band.field]}
                            onChange={(e) =>
                              onChangeChannel(ch.id, {
                                ...s,
                                [band.field]: Number(e.target.value),
                              })
                            }
                            className="w-full studio-slider"
                          />
                          <div className="text-[10px] font-mono-tabular text-center text-[#CBD2DF]">
                            {s[band.field] > 0 ? `+${s[band.field]}` : s[band.field]} dB
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. Mastering & Real WAV Export */}
      <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
              Masterização e Exportação WAV
            </h3>
            <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">
              Renderização real em áudio estéreo 44.1kHz com Autotune, Equalização, Clipper e Limitador.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              onChangeMaster({ ...master, limiterEnabled: !master.limiterEnabled })
            }
            className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-semibold cursor-pointer ${
              master.limiterEnabled
                ? 'bg-amber-500 text-[#0A0B0E]'
                : 'bg-[#1A1D26] text-[#CBD2DF] border border-[#2D3342]'
            }`}
          >
            Limitador Master: {master.limiterEnabled ? 'Ligado' : 'Desligado'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Soft Clipper (Pressão TRAP)</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {Math.round(master.clipperDrive * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={master.clipperDrive}
              onChange={(e) =>
                onChangeMaster({ ...master, clipperDrive: Number(e.target.value) })
              }
              className="w-full studio-slider"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-[#949CAE]">Volume Final Master</span>
              <span className="font-mono-tabular text-[#F4F4F6]">
                {Math.round(master.outputGain * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.4}
              max={1.2}
              step={0.02}
              value={master.outputGain}
              onChange={(e) =>
                onChangeMaster({ ...master, outputGain: Number(e.target.value) })
              }
              className="w-full studio-slider"
            />
          </div>
        </div>

        {exportError && (
          <div className="text-xs sm:text-sm text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3.5 py-2.5">
            {exportError}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#2D3342] bg-[#0D0F14] px-3.5 py-3">
          <div>
            <p className="text-sm font-semibold text-[#F4F4F6]">Qualidade WAV</p>
            <p className="text-xs text-[#949CAE]">24 bits oferece maior margem de precisão; 16 bits gera ficheiros menores.</p>
          </div>
          <select
            aria-label="Profundidade de bits WAV"
            value={bitDepth}
            disabled={exportBusy !== null}
            onChange={(event) => setBitDepth(Number(event.target.value) as 16 | 24)}
            className="min-h-[42px] rounded-lg border border-[#3A4050] bg-[#171A22] px-3 text-sm text-white"
          >
            <option value={24}>WAV 24 bits</option>
            <option value={16}>WAV 16 bits</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#2D3342] bg-[#0D0F14] px-3.5 py-3">
          <div>
            <p className="text-sm font-semibold text-[#F4F4F6]">Frequência de amostragem</p>
            <p className="text-xs text-[#949CAE]">44,1 kHz é uma escolha comum para música; 48 kHz é útil para vídeo e alguns fluxos de produção.</p>
          </div>
          <select
            aria-label="Frequência de amostragem WAV"
            value={sampleRate}
            disabled={exportBusy !== null}
            onChange={(event) => setSampleRate(Number(event.target.value) as 44100 | 48000)}
            className="min-h-[42px] rounded-lg border border-[#3A4050] bg-[#171A22] px-3 text-sm text-white"
          >
            <option value={44100}>44,1 kHz</option>
            <option value={48000}>48 kHz</option>
          </select>
        </div>

        <div className="rounded-xl border border-[#2D3342] bg-[#0D0F14] p-3.5 space-y-3">
          <div>
            <p className="text-sm font-semibold text-[#F4F4F6]">Exportar pista individual (stems)</p>
            <p className="text-xs text-[#949CAE]">Cada ficheiro começa no segundo zero e mantém a duração da sessão, para alinhar as pistas ao importá-las noutro estúdio.</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              aria-label="Pista para exportar"
              value={stemTrack}
              disabled={exportBusy !== null}
              onChange={(event) => setStemTrack(event.target.value as ExportTrackId)}
              className="min-h-[44px] flex-1 rounded-lg border border-[#3A4050] bg-[#171A22] px-3 text-sm text-white"
            >
              <option value="vocal">Voz principal</option>
              <option value="808">808 Bass</option>
              <option value="kick">Kick</option>
              <option value="snare">Snare</option>
              <option value="clap">Clap</option>
              <option value="hihat">Hi-Hat</option>
              <option value="openhat">Open Hat</option>
              <option value="perc">Percussão</option>
              {allowMelodies && <option value="melody">Melodia</option>}
            </select>
            <button
              type="button"
              disabled={exportBusy !== null}
              onClick={() => handleExport('full', stemTrack)}
              className="min-h-[44px] rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-[#0A0B0E] disabled:opacity-50"
            >
              {exportBusy === 'stem' ? 'A exportar pista…' : 'Exportar pista WAV'}
            </button>
          </div>
          <button
            type="button"
            disabled={exportBusy !== null}
            onClick={handleExportAllStems}
            className="min-h-[46px] w-full rounded-xl border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-300 disabled:opacity-50"
          >
            {exportBusy === 'stemsZip' ? 'A criar pacote ZIP…' : 'Exportar todas as pistas num ZIP'}
          </button>
          <p className="text-[11px] text-[#7F899C]">O ZIP contém um WAV por pista, todos alinhados desde o segundo zero. Para proteger a memória do telemóvel, o pacote tem um limite automático de tamanho; sessões grandes devem ser exportadas pista a pista.</p>
          <p className="text-[11px] text-[#7F899C]">Para máxima compatibilidade com o BandLab, começa por WAV estéreo PCM, 16 bits / 44,1 kHz. Podes usar 24 bits / 48 kHz noutros fluxos que aceitem essas definições.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <button
            type="button"
            disabled={exportBusy !== null}
            onClick={() => handleExport('full')}
            className="min-h-[50px] px-4 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#0A0B0E] font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
          >
            {exportBusy === 'full' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span>Exportar Música (.WAV)</span>
          </button>

          <button
            type="button"
            disabled={exportBusy !== null}
            onClick={() => handleExport('vocal')}
            className="min-h-[50px] px-4 py-3 rounded-xl bg-[#1A1D26] hover:bg-[#232734] disabled:opacity-50 border border-[#2D3342] text-sm font-medium text-[#F4F4F6] flex items-center justify-center gap-2 cursor-pointer"
          >
            {exportBusy === 'vocal' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4 text-amber-400" />
            )}
            <span>Exportar Só Voz (.WAV)</span>
          </button>

          <button
            type="button"
            disabled={exportBusy !== null}
            onClick={() => handleExport('beat')}
            className="min-h-[50px] px-4 py-3 rounded-xl bg-[#1A1D26] hover:bg-[#232734] disabled:opacity-50 border border-[#2D3342] text-sm font-medium text-[#F4F4F6] flex items-center justify-center gap-2 cursor-pointer"
          >
            {exportBusy === 'beat' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4 text-amber-400" />
            )}
            <span>Exportar Só Beat (.WAV)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
