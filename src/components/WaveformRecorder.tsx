import React, { useEffect, useRef, useState } from 'react';
import { Mic, Square, Upload } from 'lucide-react';
import { PauseRegion } from '../types/studio';

interface WaveformRecorderProps {
  title: string;
  subtitle: string;
  recordLabel: string;
  stopLabel: string;
  importLabel?: string;
  audioBuffer: AudioBuffer | null;
  pauses?: PauseRegion[];
  entriesSec?: number[];
  isRecordingExternal?: boolean;
  onRecordedBlob: (blob: Blob, durationSec: number) => Promise<void>;
  onImportFile?: (file: File) => Promise<void>;
  compact?: boolean;
}

function getSupportedMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

export const WaveformRecorder: React.FC<WaveformRecorderProps> = ({
  title,
  subtitle,
  recordLabel,
  stopLabel,
  importLabel,
  audioBuffer,
  pauses = [],
  entriesSec = [],
  onRecordedBlob,
  onImportFile,
  compact = false,
}) => {
  const [recording, setRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);
  const [clippingDetected, setClippingDetected] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startPerfRef = useRef<number>(0);
  const recordedBytesRef = useRef<number>(0);
  const sizeLimitReachedRef = useRef(false);
  const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  // Draw static waveform whenever audioBuffer updates (and not recording)
  useEffect(() => {
    if (recording) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Subtle baseline
    ctx.fillStyle = '#0D0F14';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1E2330';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!audioBuffer) return;

    // Highlight pauses subtly
    const dur = Math.max(0.01, audioBuffer.duration);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    for (const p of pauses) {
      const x1 = (p.startSec / dur) * w;
      const x2 = (p.endSec / dur) * w;
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
    }

    // Draw waveform bars
    const data = audioBuffer.getChannelData(0);
    const barCount = Math.min(180, Math.floor(w / 3));
    const step = Math.max(1, Math.floor(data.length / barCount));
    const barW = w / barCount;

    ctx.fillStyle = '#F59E0B';
    for (let i = 0; i < barCount; i++) {
      let min = 1;
      let max = -1;
      const start = i * step;
      for (let j = 0; j < step; j++) {
        const v = data[start + j] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const amp = Math.max(Math.abs(min), Math.abs(max));
      const barH = Math.max(2, amp * (h * 0.88));
      ctx.fillRect(i * barW + 0.5, (h - barH) / 2, Math.max(1.5, barW - 1.5), barH);
    }

    // Draw voice entry markers
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.45)';
    ctx.lineWidth = 1;
    for (const entry of entriesSec) {
      const x = (entry / dur) * w;
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, h - 4);
      ctx.stroke();
    }
  }, [audioBuffer, pauses, entriesSec, recording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Ask MediaRecorder to flush its final dataavailable event before
      // releasing the microphone. stopStreams() then runs from onstop.
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          stopStreams();
        }
      } else {
        stopStreams();
      }
    };
  }, []);

  const stopStreams = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  };

  const startRecording = async () => {
    if (startingRef.current || recorderRef.current?.state === 'recording') return;
    startingRef.current = true;
    setMicError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicError('O navegador não suporta gravação de microfone neste contexto. Abre o site numa ligação HTTPS e tenta novamente.');
      startingRef.current = false;
      return;
    }

    try {
      if (typeof MediaRecorder === 'undefined') {
        setMicError('Este navegador não suporta gravação de áudio. Experimenta abrir o site no Chrome atualizado.');
        startingRef.current = false;
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      // The permission prompt can remain open while the user leaves this panel.
      // Do not start a recorder after the component has already unmounted.
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        startingRef.current = false;
        return;
      }
      streamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setMicError('Este navegador não disponibiliza o motor de áudio necessário para monitorizar a gravação.');
        startingRef.current = false;
        return;
      }
      const aCtx = new AudioCtx();
      audioCtxRef.current = aCtx;
      // Mobile browsers may create the context suspended; resume it from the user's tap.
      if (aCtx.state === 'suspended') {
        await aCtx.resume();
      }
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        if (aCtx.state !== 'closed') void aCtx.close();
        streamRef.current = null;
        audioCtxRef.current = null;
        startingRef.current = false;
        return;
      }
      const source = aCtx.createMediaStreamSource(stream);
      const analyser = aCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const mimeType = getSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      recordedBytesRef.current = 0;
      sizeLimitReachedRef.current = false;
      recorder.ondataavailable = (e) => {
        if (!e.data || e.data.size <= 0 || sizeLimitReachedRef.current) return;
        recordedBytesRef.current += e.data.size;
        if (recordedBytesRef.current > MAX_RECORDING_BYTES) {
          sizeLimitReachedRef.current = true;
          if (mountedRef.current) setMicError('A gravação atingiu o limite de 100 MB. A gravação foi parada para proteger a memória do dispositivo.');
          if (recorder.state !== 'inactive') {
            try { recorder.stop(); } catch { stopStreams(); }
          }
          return;
        }
        chunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        if (mountedRef.current) {
          setMicError('O navegador encontrou um erro durante a gravação. Tenta novamente.');
          setRecording(false);
          setInputLevel(0);
        }
        // Do not discard the recorder reference until its stop event has
        // had a chance to flush any final data.
        try {
          if (recorder.state !== 'inactive') recorder.stop();
          else {
            recorderRef.current = null;
            stopStreams();
          }
        } catch {
          recorderRef.current = null;
          stopStreams();
        }
      };

      recorder.onstop = async () => {
        const finalDuration = Math.max(0.1, (performance.now() - startPerfRef.current) / 1000);
        const blob = new Blob(chunksRef.current, {
          type: mimeType || recorder.mimeType || 'audio/webm',
        });
        stopStreams();
        recorderRef.current = null;
        if (mountedRef.current) {
          setRecording(false);
          setInputLevel(0);
          setPeakLevel(0);
        }
        if (!mountedRef.current) return;
        if (blob.size === 0) {
          if (mountedRef.current) setMicError('A gravação ficou vazia. Verifica o microfone e tenta novamente.');
          return;
        }
        try {
          await onRecordedBlob(blob, finalDuration);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Não foi possível processar a gravação.';
          if (mountedRef.current) setMicError(msg);
        }
      };

      recorderRef.current = recorder;
      startPerfRef.current = performance.now();
      setElapsedSec(0);
      setPeakLevel(0);
      setClippingDetected(false);
      setRecording(true);
      recorder.start(120);
      startingRef.current = false;

      timerRef.current = window.setInterval(() => {
        if (mountedRef.current) setElapsedSec((performance.now() - startPerfRef.current) / 1000);
      }, 100);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const drawLive = () => {
        const canvas = canvasRef.current;
        if (!canvas || !audioCtxRef.current) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          const magnitude = Math.abs(v);
          if (magnitude > peak) peak = magnitude;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (mountedRef.current) {
          setInputLevel(Math.min(1, rms * 3.5));
          setPeakLevel(peak);
          if (peak >= 0.985) setClippingDetected(true);
        }

        const w = canvas.width;
        const h = canvas.height;
        ctx.fillStyle = '#0D0F14';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = '#EF4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const sliceW = w / buf.length;
        for (let i = 0; i < buf.length; i++) {
          const y = (buf[i] / 128) * (h / 2);
          if (i === 0) ctx.moveTo(0, y);
          else ctx.lineTo(i * sliceW, y);
        }
        ctx.stroke();

        rafRef.current = requestAnimationFrame(drawLive);
      };
      rafRef.current = requestAnimationFrame(drawLive);
    } catch (err) {
      stopStreams();
      recorderRef.current = null;
      startingRef.current = false;
      if (mountedRef.current) {
        setRecording(false);
        const msg = err instanceof Error ? err.message : 'Permissão de microfone recusada.';
        setMicError(`Erro ao aceder ao microfone: ${msg}`);
      }
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    try {
      recorder.stop();
    } catch {
      // If the browser already stopped the recorder, release resources safely.
      recorderRef.current = null;
      stopStreams();
      if (mountedRef.current) {
        setRecording(false);
        setInputLevel(0);
        setPeakLevel(0);
      }
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && onImportFile) {
      setMicError(null);
      try {
        const allowedAudioExtension = /\.(wav|wave|mp3|m4a|aac|ogg|oga|opus|webm|flac)$/i.test(file.name);
        if (file.size < 64) {
          throw new Error('O ficheiro está vazio ou é demasiado pequeno.');
        }
        if (file.size > 50 * 1024 * 1024) {
          throw new Error('O ficheiro excede 50 MB. Escolhe um áudio mais pequeno.');
        }
        if (!file.type.toLowerCase().startsWith('audio/') && !allowedAudioExtension) {
          throw new Error('Escolhe um ficheiro de áudio válido.');
        }
        await onImportFile(file);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Não foi possível importar o ficheiro de áudio.';
        setMicError(message);
      }
    }
  };

  const formatSec = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const tenths = Math.floor((s % 1) * 10);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
  };

  return (
    <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">{title}</h3>
          <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">{subtitle}</p>
        </div>
        <div className="font-mono-tabular text-xs sm:text-sm text-[#CBD2DF] bg-[#0D0F14] border border-[#252A36] px-3 py-1.5 rounded-lg">
          {recording
            ? `GRAVANDO · ${formatSec(elapsedSec)}`
            : audioBuffer
              ? `Duração ${formatSec(audioBuffer.duration)}`
              : 'Sem áudio'}
        </div>
      </div>

      {/* Waveform / Oscilloscope Canvas */}
      <div className="relative rounded-xl overflow-hidden border border-[#252A36] bg-[#0D0F14]">
        <canvas
          ref={canvasRef}
          width={720}
          height={compact ? 84 : 116}
          className="w-full h-20 sm:h-28 block"
        />
        {!audioBuffer && !recording && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-4 text-center">
            <span className="text-xs sm:text-sm text-[#6B7385]">
              Carregue em gravar e cante livremente — sem precisar de escrever letra
            </span>
          </div>
        )}
      </div>

      {/* Real-time mic input VU bar when recording */}
      {recording && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-[#949CAE] font-mono-tabular">
            <span>Nível de Entrada do Microfone</span>
            <span>{Math.round(inputLevel * 100)}%</span>
          </div>
          <div className="flex justify-between text-[11px] text-[#949CAE]">
            <span>Pico: {Math.round(peakLevel * 100)}%</span>
            <span className={clippingDetected ? 'text-red-400 font-semibold' : 'text-emerald-400'}>
              {clippingDetected ? 'Possível saturação — afasta o microfone ou reduz o volume' : 'Sem saturação detetada'}
            </span>
          </div>
          <div className="h-2 bg-[#0D0F14] rounded-full overflow-hidden border border-[#252A36]">
            <div
              className="h-full bg-red-500 transition-all duration-75"
              style={{ width: `${Math.round(inputLevel * 100)}%` }}
            />
          </div>
        </div>
      )}

      {micError && (
        <div className="text-xs sm:text-sm text-red-300 bg-red-950/40 border border-red-800/60 rounded-xl px-3.5 py-2.5">
          {micError}
        </div>
      )}

      {/* Large Mobile-Friendly Action Buttons (>= 48px height) */}
      <div className="flex flex-wrap gap-3">
        {!recording ? (
          <button
            type="button"
            onClick={startRecording}
            className="flex-1 min-w-[180px] min-h-[48px] px-5 py-3 rounded-xl bg-red-600 hover:bg-red-500 active:scale-[0.99] text-white font-semibold text-sm sm:text-base flex items-center justify-center gap-2.5 transition-all cursor-pointer whitespace-nowrap"
          >
            <Mic className="w-5 h-5 shrink-0" />
            <span>{recordLabel}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={stopRecording}
            className="flex-1 min-w-[180px] min-h-[48px] px-5 py-3 rounded-xl bg-[#F4F4F6] hover:bg-white active:scale-[0.99] text-[#0A0B0E] font-semibold text-sm sm:text-base flex items-center justify-center gap-2.5 transition-all cursor-pointer whitespace-nowrap"
          >
            <Square className="w-4 h-4 fill-current shrink-0" />
            <span>{stopLabel}</span>
          </button>
        )}

        {onImportFile && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              disabled={recording}
              onClick={() => fileInputRef.current?.click()}
              className="min-h-[48px] px-4 py-3 rounded-xl bg-[#1A1D26] hover:bg-[#232734] disabled:opacity-45 border border-[#2D3342] text-[#E2E6EE] font-medium text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Upload className="w-4 h-4 shrink-0" />
              <span>{importLabel || 'Importar Ficheiro'}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
};
