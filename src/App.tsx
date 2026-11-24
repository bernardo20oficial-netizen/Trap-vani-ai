import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Disc3,
  FolderKanban,
  Loader2,
  Mic,
  Music,
  Play,
  Sliders,
  Sparkles,
  Square,
} from 'lucide-react';
import { analyzeMouthBeatBuffer, analyzeVocalBuffer } from './audio/dspAnalysis';
import {
  BUILTIN_808_LIBRARY,
  BUILTIN_808_PACKS,
  LEGACY_808_ID_MAP,
} from './audio/library808';
import { StudioAudioEngine } from './audio/studioEngine';
import { createStoredZip, ZipEntry } from './audio/zipArchive';
import {
  CURRENT_PATTERN_VERSION,
  createStyleTrapBeat,
  TrapStylePresetId,
} from './audio/trapArranger';
import { BeatStudioPanel } from './components/BeatStudioPanel';
import { Library808Panel } from './components/Library808Panel';
import { MixerAndExportPanel } from './components/MixerAndExportPanel';
import { ProjectsAndAiPanel } from './components/ProjectsAndAiPanel';
import { VocalAndAutotunePanel } from './components/VocalAndAutotunePanel';
import {
  audioBufferToCompactWavBase64,
  createProjectBackup,
  restoreProjectBackup,
  createDefaultMixer,
  createDefaultProject,
  createEmptySteps,
  createStarterPattern,
  deleteCustom808,
  deleteCustomPack808,
  deleteProjectById,
  getAudioBlob,
  listCustom808s,
  listCustomPacks808,
  listProjects,
  saveAudioBlob,
  replaceProjectAudio,
  saveCustom808,
  saveCustomPack808,
  saveProject,
} from './storage/studioDb';
import {
  Ai808Recommendation,
  BeatDirectionConstraints,
  BeatPattern,
  BeatStep,
  BeatTrackId,
  ExportTrackId,
  MonitorMode,
  MouthHitEvent,
  MusicalKey,
  MusicalScale,
  Pack808,
  Sample808,
  TrapProject,
  VocalAnalysisResult,
} from './types/studio';

type StudioTab = 'vocal' | 'beat' | 'mixer' | 'projects';

const MAX_808_FILE_BYTES = 25 * 1024 * 1024;
const MAX_808_DURATION_SEC = 8;
const MIN_808_DURATION_SEC = 0.05;
const VALID_KEYS: MusicalKey[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const VALID_SCALES: MusicalScale[] = [
  'minor',
  'harmonic_minor',
  'phrygian',
  'dorian',
  'major',
  'chromatic',
];

function sanitizeKey(raw: string, fallback: MusicalKey): MusicalKey {
  const up = raw.trim().toUpperCase() as MusicalKey;
  return VALID_KEYS.includes(up) ? up : fallback;
}

function sanitizeScale(raw: string, fallback: MusicalScale): MusicalScale {
  const norm = raw.trim().toLowerCase().replace(/\s+/g, '_') as MusicalScale;
  return VALID_SCALES.includes(norm) ? norm : fallback;
}

const NOTE_NAME_TO_SEMI: Record<string, number> = {
  C: 0,
  'C#': 1,
  DB: 1,
  D: 2,
  'D#': 3,
  EB: 3,
  E: 4,
  F: 5,
  'F#': 6,
  GB: 6,
  G: 7,
  'G#': 8,
  AB: 8,
  A: 9,
  'A#': 10,
  BB: 10,
  B: 11,
};

function detectRootMidiFromFilename(filename: string, fallback = 36): number {
  const stem = filename.replace(/\.[^.]+$/, '');
  const match = stem.match(/(?:^|[_\-\s(\[])([A-Ga-g][#bB]?)([0-4])?(?:m|maj|min)?(?=$|[_\-\s)\]])/);
  if (!match) return fallback;
  const semi = NOTE_NAME_TO_SEMI[match[1].toUpperCase()];
  if (typeof semi !== 'number') return fallback;
  const midi = 36 + semi;
  return midi > 43 ? midi - 12 : midi;
}

async function computeBlobSha256(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return `len:${buf.byteLength}`;
}

export interface Import808Summary {
  addedCount: number;
  skippedDuplicates: number;
  skippedInvalid: number;
}

export default function App() {
  const engineRef = useRef<StudioAudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new StudioAudioEngine();
  }

  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [projects, setProjects] = useState<TrapProject[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [custom808s, setCustom808s] = useState<Sample808[]>([]);
  const [customPacks808, setCustomPacks808] = useState<Pack808[]>([]);
  const [activeTab, setActiveTab] = useState<StudioTab>('vocal');

  const [vocalBuffer, setVocalBuffer] = useState<AudioBuffer | null>(null);
  const [mouthBuffer, setMouthBuffer] = useState<AudioBuffer | null>(null);
  const [active808Buffer, setActive808Buffer] = useState<AudioBuffer | null>(null);

  const [monitorMode, setMonitorMode] = useState<MonitorMode>('full');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackNotice, setPlaybackNotice] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [meterLevel, setMeterLevel] = useState(0);

  const [vocalBusy, setVocalBusy] = useState(false);
  const [vocalError, setVocalError] = useState<string | null>(null);
  const [mouthBusy, setMouthBusy] = useState(false);
  const [mouthError, setMouthError] = useState<string | null>(null);
  const [directionBusy, setDirectionBusy] = useState(false);
  const [directionError, setDirectionError] = useState<string | null>(null);
  const [beatBusy, setBeatBusy] = useState(false);
  const [beatError, setBeatError] = useState<string | null>(null);

  const [aiRecommendations, setAiRecommendations] = useState<Ai808Recommendation[]>([]);
  const [aiRecSummary, setAiRecSummary] = useState<string | null>(null);
  const [aiRecBusy, setAiRecBusy] = useState(false);
  const [aiRecError, setAiRecError] = useState<string | null>(null);

  // Todas as gravações automáticas passam por este ponto para que uma falha
  // de quota, permissões ou IndexedDB não fique escondida em Promises ignoradas.
  const persistProject = useCallback(async (project: TrapProject) => {
    try {
      await saveProject(project);
    } catch (error) {
      setPlaybackNotice(
        error instanceof Error
          ? `Não foi possível guardar o projeto: ${error.message}`
          : 'Não foi possível guardar o projeto neste dispositivo. Exporte uma cópia antes de sair.'
      );
    }
  }, []);

  const all808s = useMemo(
    () => [...BUILTIN_808_LIBRARY, ...custom808s],
    [custom808s]
  );

  const allPacks = useMemo(() => {
    const hasPhoneImports = custom808s.some((s) => s.packId === 'pack_imported_phone');
    const phonePack: Pack808[] = hasPhoneImports
      ? [
          {
            id: 'pack_imported_phone',
            name: 'Importados do Telefone',
            description: 'Ficheiros 808 carregados diretamente do dispositivo.',
            style: 'Importado pelo Artista',
            license: 'Samples do Artista',
            isCustom: false,
            createdAt: 5,
          },
        ]
      : [];
    return [...BUILTIN_808_PACKS, ...phonePack, ...customPacks808];
  }, [custom808s, customPacks808]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeId) || projects[0] || null,
    [projects, activeId]
  );

  const selected808 = useMemo(
    () =>
      all808s.find((s) => s.id === activeProject?.selected808Id && s.available) ||
      all808s.find((s) => s.available) ||
      all808s[0],
    [all808s, activeProject?.selected808Id]
  );

  // Boot: load projects and custom 808s from IndexedDB (and migrate legacy 808 IDs)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [loadedProjects, loaded808s, loadedPacks] = await Promise.all([
        listProjects(),
        listCustom808s(),
        listCustomPacks808(),
      ]);
      if (cancelled) return;

      let list = loadedProjects.map((p) => {
        let updated = p;
        let changed = false;
        const mappedId = LEGACY_808_ID_MAP[p.selected808Id];
        if (mappedId) {
          updated = { ...updated, selected808Id: mappedId };
          changed = true;
        }
        const desc = p.beatPattern?.descriptionPt || '';
        const isLegacyStarterDesc =
          desc.startsWith('Base inicial') ||
          desc.startsWith('Base moderna') ||
          desc.startsWith('Produção TRAP de 4 compassos') ||
          desc.startsWith('Trap Americano · 4 compassos');
        const needsStarterUpgrade =
          p.beatPattern?.createdFrom === 'manual' &&
          ((p.beatPattern?.patternVersion ?? 1) < CURRENT_PATTERN_VERSION || isLegacyStarterDesc);

        if (needsStarterUpgrade) {
          const targetBpm = p.bpm === 136 || p.bpm === 138 ? 140 : p.bpm || 140;
          updated = {
            ...updated,
            bpm: targetBpm,
            beatPattern: createStarterPattern(targetBpm),
            mixer: createDefaultMixer(),
            master: {
              ...updated.master,
              clipperDrive:
                updated.master?.clipperDrive === 0.25 ? 0.12 : (updated.master?.clipperDrive ?? 0.12),
            },
          };
          changed = true;
        } else if (updated.beatPattern && updated.beatPattern.bpm !== updated.bpm) {
          updated = {
            ...updated,
            beatPattern: {
              ...updated.beatPattern,
              bpm: updated.bpm,
            },
          };
          changed = true;
        }
        if (changed) {
          void persistProject(updated);
        }
        return updated;
      });
      if (list.length === 0) {
        const starter = createDefaultProject('Sessão Trap 01');
        await saveProject(starter);
        list = [starter];
      }
      setProjects(list);
      setActiveId(list[0].id);
      setCustom808s(loaded808s);
      setCustomPacks808(loadedPacks);
      setBooted(true);
      void engineRef.current?.ensureKitBuffers().catch(() => {});
    })().catch((error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : 'Não foi possível abrir o armazenamento do estúdio.';
      setBootError(message);
    });
    return () => {
      cancelled = true;
    };
  }, [persistProject]);

  // Load audio blobs whenever active project or selected custom 808 changes
  useEffect(() => {
    if (!activeProject || !engineRef.current) return;
    let cancelled = false;

    (async () => {
      const engine = engineRef.current!;
      if (activeProject.vocalBlobKey) {
        const blob = await getAudioBlob(activeProject.vocalBlobKey);
        if (blob && !cancelled) {
          try {
            const buf = await engine.decodeAudioBlob(blob);
            if (!cancelled) setVocalBuffer(buf);
          } catch {
            if (!cancelled) setVocalBuffer(null);
          }
        } else if (!cancelled) {
          setVocalBuffer(null);
        }
      } else {
        setVocalBuffer(null);
      }

      if (activeProject.mouthBlobKey) {
        const blob = await getAudioBlob(activeProject.mouthBlobKey);
        if (blob && !cancelled) {
          try {
            const buf = await engine.decodeAudioBlob(blob);
            if (!cancelled) setMouthBuffer(buf);
          } catch {
            if (!cancelled) setMouthBuffer(null);
          }
        } else if (!cancelled) {
          setMouthBuffer(null);
        }
      } else {
        setMouthBuffer(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProject?.id, activeProject?.vocalBlobKey, activeProject?.mouthBlobKey]);

  useEffect(() => {
    if (!selected808 || !engineRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        let customBlob: Blob | null = null;
        if (selected808.isCustom && selected808.audioBlobKey) {
          customBlob = await getAudioBlob(selected808.audioBlobKey);
        }
        const buf = await engineRef.current!.load808Buffer(selected808, customBlob);
        if (!cancelled) setActive808Buffer(buf);
      } catch {
        if (!cancelled) setActive808Buffer(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected808?.id, selected808?.audioBlobKey, selected808?.audioUrl]);

  // Keep audio engine synchronized with state
  useEffect(() => {
    if (!activeProject || !selected808 || !engineRef.current) return;
    engineRef.current.updateSessionData({
      project: activeProject,
      monitorMode,
      vocalBuffer,
      selected808,
      active808Buffer,
    });
  }, [activeProject, monitorMode, vocalBuffer, selected808, active808Buffer]);

  const updateActiveProject = useCallback(
    (updater: (prev: TrapProject) => TrapProject) => {
      setProjects((prevList) =>
        prevList.map((p) => {
          if (p.id !== activeId) return p;
          const next = { ...updater(p), updatedAt: Date.now() };
          void persistProject(next);
          return next;
        })
      );
    },
    [activeId, persistProject]
  );

  const handleStopPlayback = useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      engine.stopPlayback();
      engine.stopPreview808();
    }
    setIsPlaying(false);
    setMeterLevel(0);
  }, []);

  const handlePlayMode = async (targetMode: MonitorMode) => {
    const engine = engineRef.current;
    if (!engine || !activeProject || !selected808) return;

    // If clicking the exact same active playback mode, stop it cleanly
    if (isPlaying && monitorMode === targetMode) {
      handleStopPlayback();
      return;
    }

    setPlaybackNotice(null);
    if (targetMode === 'full' && !vocalBuffer) {
      setPlaybackNotice(
        'Ainda não gravou ou importou uma voz. A reproduzir o beat atual — quando adicionar a sua voz, "Reproduzir música" tocará voz + beat juntos.'
      );
    }
    if (targetMode === 'vocal' && !vocalBuffer) {
      setPlaybackNotice('Grave ou importe uma voz primeiro para ouvir "Só Voz".');
      return;
    }

    setMonitorMode(targetMode);

    const ctx = engine.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    let resolved808Buf = active808Buffer;
    if (!resolved808Buf && selected808.available) {
      try {
        const customBlob =
          selected808.isCustom && selected808.audioBlobKey
            ? await getAudioBlob(selected808.audioBlobKey)
            : null;
        resolved808Buf = await engine.load808Buffer(selected808, customBlob);
        setActive808Buffer(resolved808Buf);
      } catch {
        // Proceed cleanly without crashing transport
      }
    }

    engine.updateSessionData({
      project: activeProject,
      monitorMode: targetMode,
      vocalBuffer,
      selected808,
      active808Buffer: resolved808Buf,
    });

    setIsPlaying(true);
    try {
      await engine.startPlayback(
        (step, elapsed, meter) => {
          setCurrentStep(step);
          setElapsedSec(elapsed);
          setMeterLevel(meter);
        },
        () => {
          setIsPlaying(false);
          setMeterLevel(0);
        }
      );
    } catch (err) {
      engine.stopPlayback();
      setIsPlaying(false);
      setMeterLevel(0);
      setPlaybackNotice(
        err instanceof Error
          ? err.message
          : 'Não foi possível iniciar a reprodução de áudio neste momento.'
      );
    }
  };

  const handleMonitorChange = (nextMode: MonitorMode) => {
    setMonitorMode(nextMode);
    if (isPlaying && engineRef.current && activeProject && selected808) {
      engineRef.current.updateSessionData({
        project: activeProject,
        monitorMode: nextMode,
        vocalBuffer,
        selected808,
        active808Buffer,
      });
    }
  };

  const handleSaveVocalBlob = async (blob: Blob, fileName: string) => {
    if (!activeProject || !engineRef.current) return;
    setVocalError(null);
    const key = `vocal_${activeProject.id}_${Date.now()}`;
    // Validar/decodificar antes de substituir o áudio que já está guardado.
    const decoded = await engineRef.current.decodeAudioBlob(blob);
    const dsp = analyzeVocalBuffer(decoded);
    const updated = await replaceProjectAudio(
      {
        ...activeProject,
        vocalBlobKey: key,
        vocalFileName: fileName,
        vocalDurationSec: decoded.duration,
        vocalDsp: dsp,
        vocalAnalysis: null,
      },
      key,
      blob,
      activeProject.vocalBlobKey
    );
    setProjects((prev) => prev.map((project) => project.id === updated.id ? updated : project));
    setVocalBuffer(decoded);
  };

  const handleAnalyzeVocal = async () => {
    if (!activeProject || !vocalBuffer || !activeProject.vocalDsp) return;
    setVocalError(null);
    setVocalBusy(true);
    try {
      const wav = audioBufferToCompactWavBase64(vocalBuffer, 35);
      const res = await fetch('/api/ai/analyze-vocal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: wav.base64,
          mimeType: wav.mimeType,
          dspMetrics: activeProject.vocalDsp,
          available808s: all808s
            .filter((s) => s.available)
            .map((s) => ({
              id: s.id,
              name: s.name,
              category: s.category,
              character: s.character,
            })),
        }),
      });
      const data = (await res.json()) as {
        analysis?: {
          bpm: number;
          detectedKey: string;
          detectedScale: string;
          cadence: string;
          intensityProfile: string;
          recommended808Id: string;
          summaryPt: string;
        };
        error?: string;
      };
      if (!res.ok || !data.analysis) {
        throw new Error(data.error || 'Erro ao analisar a voz.');
      }

      const a = data.analysis;
      const cleanKey = sanitizeKey(a.detectedKey, activeProject.vocalDsp.detectedKey);
      const cleanScale = sanitizeScale(a.detectedScale, activeProject.vocalDsp.detectedScale);
      const cleanBpm = Math.max(70, Math.min(180, Math.round(a.bpm || activeProject.vocalDsp.estimatedBpm)));

      const result: VocalAnalysisResult = {
        bpm: cleanBpm,
        detectedKey: cleanKey,
        detectedScale: cleanScale,
        cadence: a.cadence,
        intensityProfile: a.intensityProfile,
        entriesSec: activeProject.vocalDsp.entryTimestampsSec,
        pauses: activeProject.vocalDsp.pauses,
        recommended808Id: a.recommended808Id,
        summaryPt: a.summaryPt,
        analyzedAt: Date.now(),
      };

      const canAutoReplace808 =
        !activeProject.lock808Selection &&
        activeProject.auto808Mode &&
        all808s.some((s) => s.id === a.recommended808Id && s.available);

      if (all808s.some((s) => s.id === a.recommended808Id && s.available)) {
        setAiRecommendations([
          {
            sampleId: a.recommended808Id,
            reasonPt: canAutoReplace808
              ? `Selecionado automaticamente pela IA após análise da voz (${cleanBpm} BPM, ${cleanKey} ${cleanScale.replace('_', ' ')}).`
              : `Recomendado após análise da sua voz (${cleanBpm} BPM, ${cleanKey} ${cleanScale.replace('_', ' ')}).`,
          },
        ]);
        setAiRecSummary(
          canAutoReplace808
            ? '808 escolhido automaticamente conforme autorização do artista.'
            : 'Sugestão baseada na sua gravação vocal (escolha manual protegida).'
        );
      }

      updateActiveProject((prev) => ({
        ...prev,
        selected808Id: canAutoReplace808 ? a.recommended808Id : prev.selected808Id,
        vocalAnalysis: result,
      }));
    } catch (err) {
      setVocalError(err instanceof Error ? err.message : 'Falha na análise da voz.');
    } finally {
      setVocalBusy(false);
    }
  };

  const handlePreview808 = async (sample: Sample808, midiNote = 36) => {
    if (!engineRef.current) return;
    // Previewing a 808 stops any running music/beat transport cleanly
    setIsPlaying(false);
    setMeterLevel(0);
    setPlaybackNotice(null);
    let blob: Blob | null = null;
    if (sample.isCustom && sample.audioBlobKey) {
      blob = await getAudioBlob(sample.audioBlobKey);
    }
    await engineRef.current.preview808(sample, blob, midiNote);
  };

  const handleRequestAiRecommendations = async () => {
    if (!activeProject) return;
    setAiRecError(null);
    setAiRecBusy(true);
    try {
      const res = await fetch('/api/ai/recommend-808', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bpm: activeProject.bpm,
          key: activeProject.key,
          scale: activeProject.scale,
          mood: activeProject.directionConstraints.mood,
          directionPrompt: activeProject.directionPrompt,
          vocalSummary: activeProject.vocalAnalysis?.summaryPt || '',
          current808Id: activeProject.selected808Id,
          available808s: all808s
            .filter((s) => s.available)
            .map((s) => ({
              id: s.id,
              name: s.name,
              style: s.style,
              sonority: s.sonority,
              character: s.character,
              packName: s.packName,
              tags: s.tags,
            })),
        }),
      });
      const data = (await res.json()) as {
        summaryPt?: string;
        recommendations?: Ai808Recommendation[];
        error?: string;
      };
      if (!res.ok || !data.recommendations) {
        throw new Error(data.error || 'Não foi possível gerar recomendações de 808.');
      }
      setAiRecommendations(data.recommendations);
      setAiRecSummary(data.summaryPt || null);
    } catch (err) {
      setAiRecError(
        err instanceof Error ? err.message : 'Erro ao pedir recomendações à IA.'
      );
    } finally {
      setAiRecBusy(false);
    }
  };

  const handleImportFiles808 = async (params: {
    files: File[];
    packId: string;
    packName: string;
    category: string;
    sonority: string;
    rootNote: number;
    license: string;
    tags: string[];
  }): Promise<Import808Summary> => {
    const added: Sample808[] = [];
    const knownHashes = new Set(
      custom808s.map((s) => s.fileHash).filter((h): h is string => Boolean(h))
    );
    let skippedDuplicates = 0;
    let skippedInvalid = 0;

    for (let i = 0; i < params.files.length; i++) {
      const file = params.files[i];
      // Reject empty and oversized files before hashing/decoding. Decoding can
      // expand compressed audio dramatically in memory on mobile devices.
      if (file.size < 64 || file.size > MAX_808_FILE_BYTES) {
        skippedInvalid++;
        continue;
      }

      const fileHash = await computeBlobSha256(file);
      if (knownHashes.has(fileHash)) {
        skippedDuplicates++;
        continue;
      }

      let durationSec = 1.1;
      try {
        if (!engineRef.current) throw new Error('Motor de áudio indisponível.');
        const decoded = await engineRef.current.decodeAudioBlob(file);
        if (
          !Number.isFinite(decoded.duration) ||
          decoded.duration < MIN_808_DURATION_SEC ||
          decoded.duration > MAX_808_DURATION_SEC ||
          decoded.numberOfChannels < 1 ||
          decoded.numberOfChannels > 2 ||
          decoded.sampleRate < 8000 ||
          decoded.sampleRate > 192000
        ) {
          skippedInvalid++;
          continue;
        }
        durationSec = decoded.duration;
      } catch {
        skippedInvalid++;
        continue;
      }

      knownHashes.add(fileHash);
      const id = `808_custom_${Date.now()}_${i}`;
      const blobKey = `blob_${id}`;
      await saveAudioBlob(blobKey, file);
      const cleanName = file.name.replace(/\.[^.]+$/, '');
      const detectedRoot = detectRootMidiFromFilename(file.name, params.rootNote);
      const sample: Sample808 = {
        id,
        name: cleanName,
        category: params.category,
        categories: [params.category],
        style: params.category,
        sonority: params.sonority,
        packId: params.packId,
        packName: params.packName,
        tags: [...params.tags, params.category.toLowerCase(), cleanName.toLowerCase()],
        character: `Sample próprio/licenciado (${file.name}).`,
        rootNote: detectedRoot,
        punch: 0.82,
        subDecay: Number(durationSec.toFixed(2)),
        saturation: 0.3,
        glideMs: 40,
        license: params.license,
        available: true,
        durationSec: Number(durationSec.toFixed(2)),
        isCustom: true,
        audioBlobKey: blobKey,
        fileHash,
      };
      await saveCustom808(sample);
      added.push(sample);
    }

    if (added.length > 0) {
      setCustom808s((prev) => [...prev, ...added]);
      if (added.length === 1) {
        updateActiveProject((prev) => ({
          ...prev,
          selected808Id: added[0].id,
          lock808Selection: true,
        }));
      }
    }

    return {
      addedCount: added.length,
      skippedDuplicates,
      skippedInvalid,
    };
  };

  const handleCreatePack808 = async (params: {
    name: string;
    description: string;
    category: string;
    license: string;
    files: File[];
  }): Promise<Import808Summary> => {
    const packId = `pack_custom_${Date.now()}`;
    const newPack: Pack808 = {
      id: packId,
      name: params.name,
      description: params.description,
      style: params.category,
      license: params.license,
      isCustom: true,
      createdAt: Date.now(),
    };
    await saveCustomPack808(newPack);
    setCustomPacks808((prev) => [newPack, ...prev]);

    if (params.files.length > 0) {
      return await handleImportFiles808({
        files: params.files,
        packId,
        packName: params.name,
        category: params.category,
        sonority: 'Sample do Pacote',
        rootNote: 36,
        license: params.license,
        tags: [params.name.toLowerCase(), params.category.toLowerCase()],
      });
    }
    return { addedCount: 0, skippedDuplicates: 0, skippedInvalid: 0 };
  };

  const handleImportExternalPackUrl = async (
    manifestUrl: string
  ): Promise<Import808Summary & { packName: string }> => {
    const resp = await fetch('/api/packs/import-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifestUrl }),
    });
    const data = (await resp.json()) as {
      pack?: { name: string; description: string; style: string; license: string };
      samples?: Array<{
        name: string;
        audioUrl: string;
        category: string;
        sonority: string;
        rootNote: number;
        character: string;
        tags: string[];
      }>;
      skippedCount?: number;
      error?: string;
    };
    if (!resp.ok || !data.pack || !data.samples) {
      throw new Error(data.error || 'Erro ao carregar manifesto externo de 808.');
    }

    const knownHashes = new Set(
      custom808s.map((s) => s.fileHash).filter((h): h is string => Boolean(h))
    );
    const packId = `pack_ext_${Date.now()}`;
    const downloaded: Sample808[] = [];
    let skippedDuplicates = 0;
    let skippedInvalid = data.skippedCount || 0;

    for (let i = 0; i < data.samples.length; i++) {
      const item = data.samples[i];
      try {
        const audioResp = await fetch(
          `/api/packs/proxy-audio?url=${encodeURIComponent(item.audioUrl)}`
        );
        if (!audioResp.ok) {
          skippedInvalid++;
          continue;
        }
        const blob = await audioResp.blob();
        const fileHash = await computeBlobSha256(blob);
        if (knownHashes.has(fileHash)) {
          skippedDuplicates++;
          continue;
        }
        let durationSec = 1.2;
        if (engineRef.current) {
          const decoded = await engineRef.current.decodeAudioBlob(blob);
          durationSec = Math.max(0.15, Math.min(8, decoded.duration));
        }
        knownHashes.add(fileHash);
        const id = `808_ext_${Date.now()}_${i}`;
        const blobKey = `blob_${id}`;
        await saveAudioBlob(blobKey, blob);

        const sample: Sample808 = {
          id,
          name: item.name,
          category: item.category,
          categories: [item.category],
          style: item.category,
          sonority: item.sonority,
          packId,
          packName: data.pack.name,
          tags: item.tags,
          character: item.character,
          rootNote: item.rootNote,
          punch: 0.85,
          subDecay: Number(durationSec.toFixed(2)),
          saturation: 0.35,
          glideMs: 40,
          license: data.pack.license,
          available: true,
          durationSec: Number(durationSec.toFixed(2)),
          isCustom: true,
          audioBlobKey: blobKey,
          fileHash,
        };
        await saveCustom808(sample);
        downloaded.push(sample);
      } catch {
        skippedInvalid++;
      }
    }

    if (downloaded.length === 0) {
      throw new Error(
        skippedDuplicates > 0
          ? 'Todos os samples deste pacote externo já existiam na sua biblioteca.'
          : 'Não foi possível descodificar nenhum áudio válido a partir do pacote externo.'
      );
    }

    const newPack: Pack808 = {
      id: packId,
      name: data.pack.name,
      description: data.pack.description,
      style: data.pack.style,
      license: data.pack.license,
      isCustom: true,
      createdAt: Date.now(),
    };
    await saveCustomPack808(newPack);
    setCustomPacks808((prev) => [newPack, ...prev]);
    setCustom808s((prev) => [...prev, ...downloaded]);

    return {
      packName: data.pack.name,
      addedCount: downloaded.length,
      skippedDuplicates,
      skippedInvalid,
    };
  };

  const handleDeleteCustom808 = async (id: string) => {
    // O registo e o Blob são removidos na mesma transação IndexedDB.
    await deleteCustom808(id);
    setCustom808s((prev) => prev.filter((s) => s.id !== id));
    if (activeProject?.selected808Id === id) {
      updateActiveProject((prev) => ({
        ...prev,
        selected808Id: BUILTIN_808_LIBRARY[0].id,
      }));
    }
  };

  const handleDeleteCustomPack = async (packId: string) => {
    const packSamples = custom808s.filter((s) => s.packId === packId);
    // Pacote, samples e respetivos Blobs são removidos atomicamente.
    await deleteCustomPack808(packId);
    setCustom808s((prev) => prev.filter((s) => s.packId !== packId));
    setCustomPacks808((prev) => prev.filter((p) => p.id !== packId));
    if (packSamples.some((s) => s.id === activeProject?.selected808Id)) {
      updateActiveProject((prev) => ({
        ...prev,
        selected808Id: BUILTIN_808_LIBRARY[0].id,
      }));
    }
  };

  const handleSaveMouthBlob = async (blob: Blob) => {
    if (!activeProject || !engineRef.current) return;
    setMouthError(null);
    const key = `mouth_${activeProject.id}_${Date.now()}`;
    // Só substituir a gravação anterior depois de confirmar que o áudio novo é válido.
    const decoded = await engineRef.current.decodeAudioBlob(blob);
    const updated = await replaceProjectAudio(
      {
        ...activeProject,
        mouthBlobKey: key,
        mouthDurationSec: decoded.duration,
      },
      key,
      blob,
      activeProject.mouthBlobKey
    );
    setProjects((prev) => prev.map((project) => project.id === updated.id ? updated : project));
    setMouthBuffer(decoded);
  };

  const handleConvertMouthToBeat = async () => {
    if (!activeProject || !mouthBuffer) return;
    setMouthError(null);
    setMouthBusy(true);
    try {
      const dsp = analyzeMouthBeatBuffer(mouthBuffer);
      const wav = audioBufferToCompactWavBase64(mouthBuffer, 25);

      const res = await fetch('/api/ai/mouth-to-beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: wav.base64,
          mimeType: wav.mimeType,
          detectedHits: dsp.hits,
          estimatedBpm: dsp.estimatedBpm,
        }),
      });
      const data = (await res.json()) as {
        result?: {
          bpm: number;
          descriptionPt: string;
          events: Array<{
            timeSec: number;
            instrument: BeatTrackId;
            velocity: number;
            noteOffset?: number;
          }>;
        };
        error?: string;
      };
      if (!res.ok || !data.result) {
        throw new Error(data.error || 'Erro ao converter o beat da boca.');
      }

      const r = data.result;
      const targetBpm = Math.max(70, Math.min(180, Math.round(r.bpm || dsp.estimatedBpm)));
      const stepDur = 60 / targetBpm / 4;

      const mouthEvents: MouthHitEvent[] = (r.events || []).map((ev) => ({
        timeSec: Math.max(0, ev.timeSec),
        instrument: ev.instrument,
        velocity: Math.max(0.2, Math.min(1, ev.velocity || 0.85)),
        note:
          ev.instrument === '808'
            ? (selected808?.rootNote || 36) + (ev.noteOffset || 0)
            : undefined,
      }));
      if (mouthEvents.length === 0) {
        throw new Error('Não foram detetadas batidas suficientes. Grave novamente com sons mais claros e pequenas pausas entre os impactos. O padrão atual foi preservado.');
      }

      // Also populate the 32-step grid for visual editing while keeping exact mouth timing active!
      const tracks: Record<BeatTrackId, BeatStep[]> = {
        '808': createEmptySteps(32),
        kick: createEmptySteps(32),
        snare: createEmptySteps(32),
        clap: createEmptySteps(32),
        hihat: createEmptySteps(32),
        openhat: createEmptySteps(32),
        perc: createEmptySteps(32),
        melody: activeProject.directionConstraints.allowMelodies
          ? Array.from({ length: 32 }, (_, idx) => {
              return (
                activeProject.beatPattern.tracks.melody[idx] ?? {
                  active: false,
                  velocity: 0.85,
                }
              );
            })
          : createEmptySteps(32),
      };

      for (const ev of mouthEvents) {
        const stepIdx = Math.round(ev.timeSec / stepDur) % 32;
        if (stepIdx >= 0 && stepIdx < 32 && ev.instrument !== 'melody') {
          tracks[ev.instrument][stepIdx] = {
            active: true,
            velocity: ev.velocity,
            note: ev.note,
          };
        }
      }

      updateActiveProject((prev) => ({
        ...prev,
        bpm: targetBpm,
        beatPattern: {
          stepsCount: 32,
          bpm: targetBpm,
          swing: 0,
          tracks,
          mouthEvents,
          useExactMouthTiming: mouthEvents.length > 0,
          createdFrom: 'mouth',
          descriptionPt: r.descriptionPt || 'Beat gerado a partir do ritmo exato da sua boca.',
        },
      }));
    } catch (err) {
      setMouthError(err instanceof Error ? err.message : 'Falha na conversão do beat.');
    } finally {
      setMouthBusy(false);
    }
  };

  const handleApplyDirection = async (overrideText?: string) => {
    if (!activeProject) return;
    const instruction = (overrideText ?? activeProject.directionPrompt).trim();
    if (!instruction) return;
    setDirectionError(null);
    setDirectionBusy(true);
    try {
      const res = await fetch('/api/ai/parse-direction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
      });
      const data = (await res.json()) as {
        constraints?: BeatDirectionConstraints;
        error?: string;
      };
      if (!res.ok || !data.constraints) {
        throw new Error(data.error || 'Erro ao interpretar a instrução.');
      }
      const nextC = data.constraints;
      updateActiveProject((prev) => {
        const nextTracks = { ...prev.beatPattern.tracks };
        if (!nextC.allowMelodies) {
          nextTracks.melody = createEmptySteps(prev.beatPattern.stepsCount);
        }
        return {
          ...prev,
          directionPrompt: instruction,
          directionConstraints: nextC,
          beatPattern: {
            ...prev.beatPattern,
            tracks: nextTracks,
          },
        };
      });
    } catch (err) {
      setDirectionError(
        err instanceof Error ? err.message : 'Falha ao interpretar a instrução.'
      );
    } finally {
      setDirectionBusy(false);
    }
  };

  const handleGenerateBeat = async (
    scope: 'all' | 'drums' | 'hihat' | '808' | 'melody'
  ) => {
    if (!activeProject || !selected808) return;
    setBeatError(null);
    setBeatBusy(true);
    try {
      const res = await fetch('/api/ai/generate-beat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bpm: activeProject.bpm,
          key: activeProject.key,
          scale: activeProject.scale,
          selected808: {
            id: selected808.id,
            name: selected808.name,
            category: selected808.category,
            rootNote: selected808.rootNote,
          },
          vocalDsp: activeProject.vocalDsp,
          constraints: activeProject.directionConstraints,
          regenerateScope: scope,
          existingTracks: activeProject.beatPattern.tracks,
        }),
      });
      const data = (await res.json()) as {
        generated?: {
          swing: number;
          descriptionPt: string;
          tracks: Record<
            BeatTrackId,
            Array<{
              step: number;
              velocity: number;
              note?: number;
              roll?: number;
              slide?: boolean;
            }>
          >;
        };
        error?: string;
      };

      if (!res.ok || !data.generated) {
        throw new Error(data.error || 'Erro ao gerar beat.');
      }

      const g = data.generated;
      const toRow = (
        arr: Array<{ step: number; velocity: number; note?: number; roll?: number; slide?: boolean }> | undefined
      ): BeatStep[] => {
        const row = createEmptySteps(32);
        for (const item of arr || []) {
          if (item.step >= 0 && item.step < 32) {
            row[item.step] = {
              active: true,
              velocity: Math.max(0.2, Math.min(1, item.velocity || 0.85)),
              note: item.note,
              roll:
                item.roll === 2 || item.roll === 3 || item.roll === 4
                  ? item.roll
                  : 1,
              slide: Boolean(item.slide),
            };
          }
        }
        return row;
      };

      updateActiveProject((prev) => {
        const cur = prev.beatPattern.tracks;
        const targetSteps: 32 | 64 = scope === 'all' ? 32 : prev.beatPattern.stepsCount;
        const fitRow = (
          arr: Array<{ step: number; velocity: number; note?: number; roll?: number; slide?: boolean }> | undefined
        ): BeatStep[] => {
          const row32 = toRow(arr);
          if (targetSteps === 64) {
            return [...row32, ...row32.map((s) => ({ ...s }))];
          }
          return row32;
        };

        const nextTracks: Record<BeatTrackId, BeatStep[]> = {
          '808': scope === 'all' || scope === '808' ? fitRow(g.tracks['808']) : cur['808'],
          kick: scope === 'all' || scope === 'drums' ? fitRow(g.tracks.kick) : cur.kick,
          snare: scope === 'all' || scope === 'drums' ? fitRow(g.tracks.snare) : cur.snare,
          clap: scope === 'all' || scope === 'drums' ? fitRow(g.tracks.clap) : cur.clap,
          hihat:
            scope === 'all' || scope === 'drums' || scope === 'hihat'
              ? fitRow(g.tracks.hihat)
              : cur.hihat,
          openhat:
            scope === 'all' || scope === 'drums' || scope === 'hihat'
              ? fitRow(g.tracks.openhat)
              : cur.openhat,
          perc: scope === 'all' || scope === 'drums' ? fitRow(g.tracks.perc) : cur.perc,
          melody: !prev.directionConstraints.allowMelodies
            ? createEmptySteps(targetSteps)
            : scope === 'all' || scope === 'melody'
              ? fitRow(g.tracks.melody)
              : cur.melody,
        };

        return {
          ...prev,
          beatPattern: {
            ...prev.beatPattern,
            stepsCount: targetSteps,
            tracks: nextTracks,
            swing: typeof g.swing === 'number' ? Math.max(0, Math.min(0.25, g.swing)) : prev.beatPattern.swing,
            useExactMouthTiming: false,
            createdFrom: 'auto',
            descriptionPt: g.descriptionPt || prev.beatPattern.descriptionPt,
          },
        };
      });
    } catch (err) {
      setBeatError(err instanceof Error ? err.message : 'Falha na geração do beat.');
    } finally {
      setBeatBusy(false);
    }
  };

  const handleExportWav = async (exportMode: MonitorMode, bitDepth: 16 | 24 = 24, sampleRate: 44100 | 48000 = 44100, soloTrack: ExportTrackId | null = null) => {
    if (!activeProject || !selected808 || !engineRef.current) return;
    let export808Buffer = active808Buffer;
    if (!export808Buffer && selected808.available) {
      const customBlob =
        selected808.isCustom && selected808.audioBlobKey
          ? await getAudioBlob(selected808.audioBlobKey)
          : null;
      export808Buffer = await engineRef.current.load808Buffer(selected808, customBlob);
    }
    const wavBlob = await engineRef.current.exportToWav({
      project: activeProject,
      vocalBuffer,
      selected808,
      active808Buffer: export808Buffer,
      exportMode,
      bitDepth,
      sampleRate,
      soloTrack,
    });
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement('a');
    const suffix = soloTrack ? `Pista_${soloTrack}` : exportMode === 'full' ? 'Completa' : exportMode === 'vocal' ? 'SoVoz' : 'SoBeat';
    a.href = url;
    a.download = `${activeProject.name.replace(/\s+/g, '_')}_${suffix}_${sampleRate}Hz_${bitDepth}bit.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const handleExportAllStems = async (bitDepth: 16 | 24, sampleRate: 44100 | 48000) => {
    if (!activeProject || !selected808 || !engineRef.current) {
      throw new Error('Abre um projeto e seleciona um 808 antes de exportar as pistas.');
    }

    const pattern = activeProject.beatPattern;
    const bpm = Number.isFinite(activeProject.bpm) ? Math.max(40, Math.min(240, activeProject.bpm)) : 140;
    const steps = Number.isFinite(pattern?.stepsCount) ? Math.max(1, Math.min(64, Math.floor(pattern.stepsCount))) : 16;
    const stepDuration = 60 / bpm / 4;
    const loopDuration = stepDuration * steps;
    const sortedMouth = pattern?.useExactMouthTiming
      ? [...(pattern.mouthEvents ?? [])].filter((event) => Number.isFinite(event.timeSec)).sort((a, b) => a.timeSec - b.timeSec)
      : [];
    const lastMouthTime = sortedMouth.length ? sortedMouth[sortedMouth.length - 1].timeSec : 0;
    const mouthLoopDuration = sortedMouth.length
      ? Math.max(loopDuration, Math.max(1, Math.ceil((lastMouthTime + stepDuration) / (stepDuration * 16))) * stepDuration * 16)
      : loopDuration;
    const estimatedDuration = vocalBuffer
      ? Math.max(vocalBuffer.duration + 1.2, loopDuration, mouthLoopDuration)
      : Math.max(loopDuration * 2, mouthLoopDuration * 2, 8);

    const trackIds: ExportTrackId[] = [
      ...(vocalBuffer ? ['vocal' as const] : []),
      '808', 'kick', 'snare', 'clap', 'hihat', 'openhat', 'perc',
      ...(activeProject.directionConstraints.allowMelodies ? ['melody' as const] : []),
    ];
    const bytesPerSample = bitDepth / 8;
    const estimatedBytes = Math.ceil(estimatedDuration * sampleRate * 2 * bytesPerSample * trackIds.length);
    const MAX_BATCH_ZIP_BYTES = 64 * 1024 * 1024;
    if (!Number.isFinite(estimatedBytes) || estimatedBytes > MAX_BATCH_ZIP_BYTES) {
      const estimatedMb = Number.isFinite(estimatedBytes) ? Math.ceil(estimatedBytes / (1024 * 1024)) : 'mais de 64';
      throw new Error(`Este pacote teria aproximadamente ${estimatedMb} MB. Para evitar bloquear o Redmi A3, o limite é 64 MB. Exporta as pistas individualmente ou escolhe WAV 16 bits / 44,1 kHz.`);
    }

    let export808Buffer = active808Buffer;
    if (!export808Buffer && selected808.available) {
      const customBlob = selected808.isCustom && selected808.audioBlobKey
        ? await getAudioBlob(selected808.audioBlobKey)
        : null;
      export808Buffer = await engineRef.current.load808Buffer(selected808, customBlob);
    }

    const labels: Record<ExportTrackId, string> = {
      vocal: '01_Voz_Principal',
      '808': '02_808_Bass',
      kick: '03_Kick',
      snare: '04_Snare',
      clap: '05_Clap',
      hihat: '06_Hi_Hat',
      openhat: '07_Open_Hat',
      perc: '08_Percussao',
      melody: '09_Melodia',
    };
    const entries: ZipEntry[] = [];
    for (const trackId of trackIds) {
      const wav = await engineRef.current.exportToWav({
        project: activeProject,
        vocalBuffer,
        selected808,
        active808Buffer: export808Buffer,
        exportMode: 'full',
        bitDepth,
        sampleRate,
        soloTrack: trackId,
      });
      entries.push({ name: `TRAP_VANI_STEMS/${labels[trackId]}.wav`, blob: wav });
    }

    const readme = [
      'TRAP VANI AI — PACOTE DE PISTAS (STEMS)',
      `Projeto: ${activeProject.name}`,
      `BPM: ${bpm}`,
      `Duração estimada: ${estimatedDuration.toFixed(2)} segundos`,
      `Formato: WAV PCM estéreo, ${bitDepth} bits, ${sampleRate} Hz`,
      'Todas as pistas começam no segundo zero para manter a sincronização.',
      'Importe todos os WAV para o seu DAW e mantenha-os alinhados no início.',
      'Nota: pistas silenciadas no misturador podem ser exportadas em silêncio.',
    ].join('\n');
    entries.push({ name: 'TRAP_VANI_STEMS/LEIA-ME.txt', blob: new Blob([readme], { type: 'text/plain;charset=utf-8' }) });

    const zipBlob = await createStoredZip(entries);
    if (zipBlob.size > MAX_BATCH_ZIP_BYTES) {
      throw new Error('O pacote final ultrapassou o limite seguro de 64 MB. Exporta as pistas individualmente.');
    }
    const url = URL.createObjectURL(zipBlob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeProject.name.replace(/[^a-z0-9_-]/gi, '_')}_STEMS_${sampleRate}Hz_${bitDepth}bit.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const handleSendChat = async (text: string, fastMode: boolean) => {
    if (!activeProject) return;
    const userMsg = {
      id: `u_${Date.now()}`,
      role: 'user' as const,
      text,
      timestamp: Date.now(),
    };
    const nextHistory = [...activeProject.chatHistory, userMsg];
    updateActiveProject((prev) => ({ ...prev, chatHistory: nextHistory }));

    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history: activeProject.chatHistory,
        message: text,
        fastMode,
        studioContext: {
          projectName: activeProject.name,
          mode: activeProject.mode,
          bpm: activeProject.bpm,
          key: `${activeProject.key} ${activeProject.scale}`,
          hasVocal: Boolean(vocalBuffer),
          autotuneEnabled: activeProject.autotune.enabled,
          selected808: selected808?.name,
          allowMelodies: activeProject.directionConstraints.allowMelodies,
          mood: activeProject.directionConstraints.mood,
        },
      }),
    });

    const data = (await res.json()) as {
      reply?: string;
      modelUsed?: string;
      error?: string;
    };
    if (!res.ok || !data.reply) {
      throw new Error(data.error || 'Erro ao comunicar com o assistente.');
    }

    const aiMsg = {
      id: `a_${Date.now()}`,
      role: 'assistant' as const,
      text: data.reply,
      modelUsed: data.modelUsed,
      timestamp: Date.now(),
    };
    updateActiveProject((prev) => ({
      ...prev,
      chatHistory: [...nextHistory, aiMsg],
    }));
  };

  if (!booted || !activeProject) {
    return (
      <div className="min-h-screen bg-[#0A0B0E] text-[#F4F4F6] flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-[#292E3A] bg-[#11141B] p-6 text-center">
          {bootError ? (
            <>
              <h1 className="text-lg font-semibold text-amber-400">Não foi possível abrir o estúdio</h1>
              <p className="mt-3 text-sm leading-6 text-[#C2C7D0]">{bootError}</p>
              <p className="mt-2 text-xs leading-5 text-[#949CAE]">Os projetos guardados não foram apagados. Verifica o espaço disponível e tenta novamente.</p>
              <button type="button" onClick={() => window.location.reload()} className="mt-5 rounded-xl bg-amber-500 px-5 py-3 text-sm font-semibold text-black">Tentar novamente</button>
            </>
          ) : (
            <div className="text-sm text-[#949CAE]">A carregar estúdio TRAP VANI AI...</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0B0E] text-[#F4F4F6] flex flex-col pb-20 md:pb-8">
      {/* Strict 3-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 h-12 md:h-14 bg-[#0A0B0E]/95 backdrop-blur-md border-b border-[#1E222D] px-4 sm:px-6 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line Brand Title */}
        <a
          href="#top"
          className="font-display text-base sm:text-lg font-bold tracking-tight text-[#F4F4F6] whitespace-nowrap shrink-0"
        >
          TRAP VANI AI
        </a>

        {/* Zone 2: 4 Clean Single-Line Studio Tabs (Desktop) */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
          {(
            [
              { id: 'vocal', label: 'Voz e Autotune' },
              { id: 'beat', label: 'Beat e 808' },
              { id: 'mixer', label: 'Mistura e Exportar' },
              { id: 'projects', label: 'Projetos e IA' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 ${
                activeTab === tab.id
                  ? 'text-amber-400 border-amber-400'
                  : 'text-[#949CAE] hover:text-[#F4F4F6] border-transparent'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Zone 3: Separated Transport Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void handlePlayMode('full')}
            className={`min-h-[38px] md:min-h-[40px] px-3 sm:px-3.5 py-1.5 rounded-xl font-semibold text-xs sm:text-sm flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              isPlaying && monitorMode === 'full'
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-amber-500 hover:bg-amber-400 text-[#0A0B0E]'
            }`}
          >
            {isPlaying && monitorMode === 'full' ? (
              <Square className="w-3.5 h-3.5 fill-current shrink-0" />
            ) : (
              <Music className="w-3.5 h-3.5 shrink-0" />
            )}
            <span>
              {isPlaying && monitorMode === 'full' ? 'Parar Música' : 'Reproduzir música'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void handlePlayMode('beat')}
            className={`min-h-[38px] md:min-h-[40px] px-3 sm:px-3.5 py-1.5 rounded-xl font-semibold text-xs sm:text-sm flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0 border ${
              isPlaying && monitorMode === 'beat'
                ? 'bg-red-600 hover:bg-red-500 border-red-500 text-white'
                : 'bg-[#1A1D26] hover:bg-[#252A36] border-[#2D3342] text-[#F4F4F6]'
            }`}
          >
            {isPlaying && monitorMode === 'beat' ? (
              <Square className="w-3.5 h-3.5 fill-current shrink-0" />
            ) : (
              <Disc3 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            )}
            <span className="hidden sm:inline">
              {isPlaying && monitorMode === 'beat' ? 'Parar Beat' : 'Reproduzir beat'}
            </span>
            <span className="sm:hidden">
              {isPlaying && monitorMode === 'beat' ? 'Parar' : 'Beat'}
            </span>
          </button>
        </div>
      </header>

      {/* Main Studio Workspace */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 pt-4 sm:pt-6 space-y-5">
        {/* Studio Control Strip (Project Info, Mode Switch, Live Transport, Live Meter) */}
        <section className="bg-[#13151B] border border-[#252A36] rounded-2xl p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-display text-lg sm:text-xl font-bold text-[#F4F4F6] truncate">
                {activeProject.name}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#949CAE] font-mono-tabular mt-0.5">
                <span>{activeProject.bpm} BPM</span>
                <span aria-hidden="true">·</span>
                <span>
                  {activeProject.key} {activeProject.scale.replace('_', ' ')}
                </span>
                <span aria-hidden="true">·</span>
                <span className="truncate max-w-[240px]">808: {selected808?.name}</span>
                <span aria-hidden="true">·</span>
                <span>{elapsedSec.toFixed(1)}s</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Automatic vs Pro Mode Switch */}
              <div className="flex items-center p-1 bg-[#0D0F14] border border-[#222733] rounded-xl">
                <button
                  type="button"
                  onClick={() =>
                    updateActiveProject((prev) => ({ ...prev, mode: 'auto' }))
                  }
                  className={`min-h-[40px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    activeProject.mode === 'auto'
                      ? 'bg-amber-500 text-[#0A0B0E]'
                      : 'text-[#949CAE] hover:text-[#F4F4F6]'
                  }`}
                >
                  Modo Automático
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateActiveProject((prev) => ({ ...prev, mode: 'pro' }))
                  }
                  className={`min-h-[40px] px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                    activeProject.mode === 'pro'
                      ? 'bg-amber-500 text-[#0A0B0E]'
                      : 'text-[#949CAE] hover:text-[#F4F4F6]'
                  }`}
                >
                  Modo Profissional
                </button>
              </div>

              {/* Isolated Vocal / Beat / Full Monitor Switch */}
              <div className="flex items-center p-1 bg-[#0D0F14] border border-[#222733] rounded-xl">
                {(
                  [
                    { id: 'full', label: 'Música' },
                    { id: 'beat', label: 'Só Beat' },
                    { id: 'vocal', label: 'Só Voz' },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleMonitorChange(m.id)}
                    className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                      monitorMode === m.id
                        ? 'bg-[#252B39] text-[#F4F4F6]'
                        : 'text-[#949CAE] hover:text-[#F4F4F6]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {/* Live Audio Output Level */}
              <div className="hidden sm:flex items-center gap-2 min-w-[90px]">
                <div className="w-20 h-2.5 bg-[#0D0F14] border border-[#222733] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-400 transition-all duration-75"
                    style={{ width: `${Math.round(meterLevel * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {playbackNotice && (
            <div className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3.5 py-2 flex items-center justify-between gap-2">
              <span>{playbackNotice}</span>
              <button
                type="button"
                onClick={() => setPlaybackNotice(null)}
                className="text-amber-400 hover:underline shrink-0 cursor-pointer"
              >
                Fechar
              </button>
            </div>
          )}
        </section>

        {/* Active Studio Section */}
        {activeTab === 'vocal' && (
          <div className="grid grid-cols-1 xl:grid-cols-[1.28fr_0.72fr] gap-5 items-start">
            <VocalAndAutotunePanel
              vocalBuffer={vocalBuffer}
              vocalFileName={activeProject.vocalFileName}
              vocalDsp={activeProject.vocalDsp}
              vocalAnalysis={activeProject.vocalAnalysis}
              isAnalyzing={vocalBusy}
              analyzeError={vocalError}
              autotune={activeProject.autotune}
              vocalFx={activeProject.vocalFx}
              onRecordedVocal={async (blob) => {
                setPlaybackNotice(null);
                await handleSaveVocalBlob(blob, 'Gravação Direta');
              }}
              onImportVocal={async (file) => {
                setPlaybackNotice(null);
                await handleSaveVocalBlob(file, file.name);
              }}
              onAnalyzeVocal={handleAnalyzeVocal}
              onApplyDetectedTiming={(bpm, key, scale) => {
                updateActiveProject((prev) => ({
                  ...prev,
                  bpm,
                  key,
                  scale,
                  beatPattern: { ...prev.beatPattern, bpm },
                  autotune: { ...prev.autotune, key, scale },
                }));
              }}
              onChangeAutotune={(next) =>
                updateActiveProject((prev) => ({ ...prev, autotune: next }))
              }
              onChangeVocalFx={(next) =>
                updateActiveProject((prev) => ({ ...prev, vocalFx: next }))
              }
            />

            {/* Quick Active 808 Card on Vocal Tab (no duplicate library grid) */}
            <div className="bg-[#13151B] border border-[#252A36] rounded-2xl p-4 sm:p-5 space-y-4">
              <div>
                <h3 className="text-base sm:text-lg font-semibold text-[#F4F4F6]">
                  808 Escolhido para esta Voz
                </h3>
                <p className="text-xs sm:text-sm text-[#949CAE] mt-0.5">
                  A IA constrói o beat à volta do 808 abaixo sem nunca substituir a sua escolha manual.
                </p>
              </div>

              <div className="bg-[#0D0F14] border border-[#252A36] rounded-xl p-4 space-y-2">
                <div className="text-xs text-[#949CAE]">{selected808?.category}</div>
                <div className="text-base font-semibold text-amber-400">
                  {selected808?.name}
                </div>
                <p className="text-xs text-[#CBD2DF] leading-relaxed">
                  {selected808?.character}
                </p>
                <div className="text-[11px] text-[#6B7385] font-mono-tabular">
                  {selected808?.sonority} · {selected808?.packName}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  disabled={!selected808?.available}
                  onClick={() => selected808 && void handlePreview808(selected808, 36)}
                  className="min-h-[46px] px-4 py-2 rounded-xl bg-[#1A1D26] hover:bg-[#232734] border border-[#2D3342] text-sm font-semibold text-[#F4F4F6] flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-current text-amber-400" />
                  <span>Ouvir Demo</span>
                </button>

                <button
                  type="button"
                  disabled={aiRecBusy}
                  onClick={handleRequestAiRecommendations}
                  className="min-h-[46px] px-4 py-2 rounded-xl bg-[#1A1D26] hover:bg-[#232734] disabled:opacity-50 border border-[#2D3342] text-sm font-semibold text-amber-300 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {aiRecBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  <span>IA Recomenda 808</span>
                </button>
              </div>

              {aiRecommendations.length > 0 && (
                <div className="bg-[#0D0F14] border border-amber-500/35 rounded-xl p-3 space-y-2">
                  <div className="text-xs font-semibold text-amber-300">
                    Sugestões para a sua voz (autorize se quiser trocar):
                  </div>
                  {aiRecommendations.map((rec) => {
                    const s = all808s.find((item) => item.id === rec.sampleId && item.available);
                    if (!s) return null;
                    const active = s.id === activeProject.selected808Id;
                    return (
                      <div
                        key={rec.sampleId}
                        className="flex items-center justify-between gap-2 bg-[#13151B] border border-[#222733] rounded-lg p-2.5"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#F4F4F6] truncate">{s.name}</div>
                          <div className="text-[11px] text-[#949CAE] truncate">{rec.reasonPt}</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => void handlePreview808(s, 36)}
                            className="min-h-[36px] px-2.5 rounded-lg bg-[#1A1D26] border border-[#2D3342] text-[11px] text-[#F4F4F6] cursor-pointer"
                          >
                            Ouvir Demo
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateActiveProject((prev) => ({
                                ...prev,
                                selected808Id: s.id,
                                lock808Selection: true,
                              }))
                            }
                            className={`min-h-[36px] px-2.5 rounded-lg text-[11px] font-semibold cursor-pointer ${
                              active
                                ? 'bg-amber-500 text-[#0A0B0E]'
                                : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                            }`}
                          >
                            {active ? 'Ativo' : 'Usar'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <button
                type="button"
                onClick={() => setActiveTab('beat')}
                className="w-full min-h-[48px] px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-[#0A0B0E] font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>Abrir Biblioteca Completa de 808 ({all808s.filter((s) => s.available).length} sons)</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {activeTab === 'beat' && (
          <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-5 items-start">
            <BeatStudioPanel
              mode={activeProject.mode}
              bpm={activeProject.bpm}
              currentStep={currentStep}
              isPlaying={isPlaying}
              mouthBuffer={mouthBuffer}
              mouthBusy={mouthBusy}
              mouthError={mouthError}
              directionPrompt={activeProject.directionPrompt}
              constraints={activeProject.directionConstraints}
              directionBusy={directionBusy}
              directionError={directionError}
              beatPattern={activeProject.beatPattern}
              beatBusy={beatBusy}
              beatError={beatError}
              onChangeBpm={(bpm) => {
                if (isPlaying) handleStopPlayback();
                updateActiveProject((prev) => ({
                  ...prev,
                  bpm,
                  beatPattern: { ...prev.beatPattern, bpm },
                }));
              }}
              onRecordedMouth={async (blob) => {
                await handleSaveMouthBlob(blob);
              }}
              onImportMouth={async (file) => {
                await handleSaveMouthBlob(file);
              }}
              onConvertMouthToBeat={handleConvertMouthToBeat}
              onToggleExactMouthTiming={() =>
                updateActiveProject((prev) => ({
                  ...prev,
                  beatPattern: {
                    ...prev.beatPattern,
                    useExactMouthTiming: !prev.beatPattern.useExactMouthTiming,
                  },
                }))
              }
              onChangeDirectionPrompt={(text) =>
                updateActiveProject((prev) => ({ ...prev, directionPrompt: text }))
              }
              onApplyDirection={handleApplyDirection}
              onClearDirection={() =>
                updateActiveProject((prev) => ({
                  ...prev,
                  directionPrompt: '',
                  directionConstraints: {
                    rawPrompt: '',
                    allowMelodies: true,
                    allowPiano: false,
                    allowSynths: true,
                    mood: 'dark',
                    sub808Intensity: 'high',
                    drumDensity: 'balanced',
                    hihatStyle: 'trap_rolls',
                    summaryPt: 'Produção equilibrada sem restrições extras.',
                  },
                }))
              }
              onGenerateBeat={async (scope) => {
                if (isPlaying) handleStopPlayback();
                await handleGenerateBeat(scope);
              }}
              onApplyPresetBeat={(presetId: TrapStylePresetId) => {
                if (isPlaying) handleStopPlayback();
                updateActiveProject((prev) => {
                  const nextPattern = createStyleTrapBeat(
                    presetId,
                    undefined,
                    prev.key,
                    prev.scale,
                    presetId === 'nao_melodico' ? false : prev.directionConstraints.allowMelodies
                  );
                  return {
                    ...prev,
                    bpm: nextPattern.bpm,
                    beatPattern: nextPattern,
                  };
                });
              }}
              onRemoveMelodies={() =>
                updateActiveProject((prev) => ({
                  ...prev,
                  directionConstraints: {
                    ...prev.directionConstraints,
                    allowMelodies: false,
                    allowPiano: false,
                    allowSynths: false,
                    summaryPt: 'Melodias removidas a pedido do artista.',
                  },
                  beatPattern: {
                    ...prev.beatPattern,
                    tracks: {
                      ...prev.beatPattern.tracks,
                      melody: createEmptySteps(prev.beatPattern.stepsCount),
                    },
                  },
                }))
              }
              onUpdatePattern={(next: BeatPattern) =>
                updateActiveProject((prev) => ({ ...prev, beatPattern: next }))
              }
            />

            <Library808Panel
              samples={all808s}
              packs={allPacks}
              selected808Id={activeProject.selected808Id}
              lock808Selection={activeProject.lock808Selection}
              auto808Mode={activeProject.auto808Mode}
              aiRecommendations={aiRecommendations}
              aiRecSummary={aiRecSummary}
              aiRecBusy={aiRecBusy}
              aiRecError={aiRecError}
              onSelect808={(id) =>
                updateActiveProject((prev) => ({
                  ...prev,
                  selected808Id: id,
                  lock808Selection: true,
                  auto808Mode: false,
                }))
              }
              onPreview808={handlePreview808}
              onToggleLock808={() =>
                updateActiveProject((prev) => ({
                  ...prev,
                  lock808Selection: !prev.lock808Selection,
                  auto808Mode: !prev.lock808Selection ? false : prev.auto808Mode,
                }))
              }
              onToggleAuto808Mode={() =>
                updateActiveProject((prev) => ({
                  ...prev,
                  auto808Mode: !prev.auto808Mode,
                }))
              }
              onRequestAiRecommendations={handleRequestAiRecommendations}
              onImportFiles808={handleImportFiles808}
              onCreatePack808={handleCreatePack808}
              onImportExternalPackUrl={handleImportExternalPackUrl}
              onDeleteCustom808={handleDeleteCustom808}
              onDeleteCustomPack={handleDeleteCustomPack}
            />
          </div>
        )}

        {activeTab === 'mixer' && (
          <MixerAndExportPanel
            mode={activeProject.mode}
            monitorMode={monitorMode}
            mixer={activeProject.mixer}
            master={activeProject.master}
            allowMelodies={activeProject.directionConstraints.allowMelodies}
            onChangeMonitorMode={handleMonitorChange}
            onChangeChannel={(ch, next) =>
              updateActiveProject((prev) => ({
                ...prev,
                mixer: { ...prev.mixer, [ch]: next },
              }))
            }
            onChangeMaster={(next) =>
              updateActiveProject((prev) => ({ ...prev, master: next }))
            }
            onExportWav={handleExportWav}
            onExportAllStems={handleExportAllStems}
          />
        )}

        {activeTab === 'projects' && (
          <ProjectsAndAiPanel
            projects={projects}
            activeProject={activeProject}
            onSelectProject={(id) => {
              if (isPlaying) handleStopPlayback();
              setActiveId(id);
            }}
            onCreateProject={() => {
              if (isPlaying) handleStopPlayback();
              const next = createDefaultProject(`Sessão Trap ${projects.length + 1}`);
              void persistProject(next);
              setProjects((prev) => [next, ...prev]);
              setActiveId(next.id);
            }}
            onRenameProject={(name) =>
              updateActiveProject((prev) => ({ ...prev, name }))
            }
            onDeleteProject={async (id) => {
              if (projects.length <= 1) return;
              // Projeto e gravações associadas são removidos na mesma transação.
              await deleteProjectById(id);
              const remaining = projects.filter((p) => p.id !== id);
              setProjects(remaining);
              if (activeId === id && remaining[0]) {
                setActiveId(remaining[0].id);
              }
            }}
            onUpdateCoverArt={(dataUrl) =>
              updateActiveProject((prev) => ({ ...prev, coverArtDataUrl: dataUrl }))
            }
            onSendChat={handleSendChat}
            onExportBackup={() => createProjectBackup(activeProject)}
            onImportBackup={async (file) => {
              const restored = await restoreProjectBackup(file);
              setProjects((prev) => [restored, ...prev]);
              setActiveId(restored.id);
              if (isPlaying) handleStopPlayback();
            }}
          />
        )}
      </main>

      {/* Mobile Bottom Thumb-Zone Navigation (Redmi A3 Android 14 Ergonomics) */}
      <nav
        aria-label="Navegação do estúdio"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-[#0D0F14]/95 backdrop-blur-md border-t border-[#1E222D] grid grid-cols-4 items-center"
      >
        {(
          [
            { id: 'vocal', label: 'Voz', Icon: Mic },
            { id: 'beat', label: 'Beat/808', Icon: Disc3 },
            { id: 'mixer', label: 'Mistura', Icon: Sliders },
            { id: 'projects', label: 'Projetos', Icon: FolderKanban },
          ] as const
        ).map(({ id, label, Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`h-full flex flex-col items-center justify-center gap-0.5 cursor-pointer ${
                active ? 'text-amber-400' : 'text-[#949CAE]'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[11px] font-medium whitespace-nowrap">{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
