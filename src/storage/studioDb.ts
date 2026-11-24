import {
  BeatPattern,
  BeatStep,
  BeatTrackId,
  MixerChannels,
  Pack808,
  Sample808,
  TrapProject,
} from '../types/studio';
import { createStyleTrapBeat } from '../audio/trapArranger';

const DB_NAME = 'trap_vani_ai_studio_v1';
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('O armazenamento local não está disponível neste navegador.'));
      return;
    }

    let settled = false;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        if (!db.objectStoreNames.contains('custom808s')) db.createObjectStore('custom808s', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('packs808')) db.createObjectStore('packs808', { keyPath: 'id' });
      } catch (error) {
        // Uma falha durante a migração deve abortar a transação, não deixar
        // uma base de dados parcialmente atualizada.
        req.transaction?.abort();
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error('Falha ao atualizar o armazenamento local.'));
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Uma abertura pode terminar depois de onblocked já ter rejeitado a Promise.
      // Nesse caso, fecha imediatamente a ligação tardia para não deixar a BD presa.
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // Permite que versões futuras atualizem a base de dados sem ficarem bloqueadas.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(req.error || new Error('Não foi possível abrir o armazenamento local.'));
    };
    req.onblocked = () => {
      if (!settled) {
        settled = true;
        reject(new Error('A atualização do armazenamento está bloqueada por outra aba. Feche as outras abas do TRAP VANI AI e tente novamente.'));
      }
    };
  });
}


function storageError(error: DOMException | null): Error {
  if (error?.name === 'QuotaExceededError') {
    return new Error('O armazenamento do telefone está cheio. Libere espaço e tente novamente.');
  }
  return error || new Error('Falha ao aceder ao armazenamento local.');
}

function closeDbWhenTransactionEnds(tx: IDBTransaction, db: IDBDatabase): void {
  const close = () => db.close();
  tx.addEventListener('complete', close, { once: true });
  tx.addEventListener('abort', close, { once: true });
  tx.addEventListener('error', close, { once: true });
}

export async function saveAudioBlob(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    closeDbWhenTransactionEnds(tx, db);
    tx.objectStore('blobs').put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError(tx.error));
    tx.onabort = () => reject(tx.error || new Error('A operação no armazenamento local foi interrompida.'));
  });
}

// Serializa todas as escritas de um mesmo projeto, incluindo substituições
// de áudio, para impedir que um autosave antigo restaure referências já trocadas.
const projectWriteQueues = new Map<string, Promise<unknown>>();

function enqueueProjectWrite<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectWriteQueues.get(projectId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  projectWriteQueues.set(projectId, current);
  return current.finally(() => {
    if (projectWriteQueues.get(projectId) === current) projectWriteQueues.delete(projectId);
  });
}

/** Guarda a nova gravação, atualiza o projeto e só então remove o áudio anterior,
 * tudo na mesma transação IndexedDB. Evita perder a gravação antiga se a nova
 * gravação ou a atualização do projeto falhar.
 */
export function replaceProjectAudio(
  project: TrapProject,
  blobKey: string,
  blob: Blob,
  previousBlobKey: string | null
): Promise<TrapProject> {
  return enqueueProjectWrite(project.id, async () => {
    const db = await openDb();
    const updatedProject = { ...project, updatedAt: Date.now() };
    return new Promise<TrapProject>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(['projects', 'blobs'], 'readwrite');
      closeDbWhenTransactionEnds(tx, db);
      tx.objectStore('blobs').put(blob, blobKey);
      tx.objectStore('projects').put(updatedProject);
      if (previousBlobKey && previousBlobKey !== blobKey) {
        tx.objectStore('blobs').delete(previousBlobKey);
      }
    } catch (error) {
      db.close();
      reject(storageError(error instanceof DOMException ? error : null));
      return;
    }
    tx.oncomplete = () => resolve(updatedProject);
    tx.onerror = () => reject(storageError(tx.error));
      tx.onabort = () => reject(storageError(tx.error));
    });
  });
}

export async function getAudioBlob(key: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    closeDbWhenTransactionEnds(tx, db);
    const req = tx.objectStore('blobs').get(key);
    req.onsuccess = () => resolve((req.result as Blob) || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAudioBlob(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    closeDbWhenTransactionEnds(tx, db);
    tx.objectStore('blobs').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError(tx.error));
    tx.onabort = () => reject(tx.error || new Error('A operação no armazenamento local foi interrompida.'));
  });
}

export async function listProjects(): Promise<TrapProject[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readonly');
    closeDbWhenTransactionEnds(tx, db);
    const req = tx.objectStore('projects').getAll();
    req.onsuccess = () => {
      const list = (req.result as TrapProject[]) || [];
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export function saveProject(project: TrapProject): Promise<void> {
  if (!project || typeof project.id !== 'string' || !project.id.trim()) {
    return Promise.reject(new Error('Não foi possível guardar: o projeto não tem um identificador válido.'));
  }

  return enqueueProjectWrite(project.id, async () => {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction('projects', 'readwrite');
        closeDbWhenTransactionEnds(tx, db);
        tx.objectStore('projects').put({ ...project, updatedAt: Date.now() });
      } catch (error) {
        db.close();
        reject(storageError(error instanceof DOMException ? error : null));
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(storageError(tx.error));
      tx.onabort = () => reject(storageError(tx.error));
    });
  });
}

export function deleteProjectById(id: string): Promise<void> {
  return enqueueProjectWrite(id, async () => {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['projects', 'blobs'], 'readwrite');
      closeDbWhenTransactionEnds(tx, db);
      const projects = tx.objectStore('projects');
      const blobs = tx.objectStore('blobs');
      const request = projects.get(id);
      request.onsuccess = () => {
        const project = request.result as TrapProject | undefined;
        if (project?.vocalBlobKey) blobs.delete(project.vocalBlobKey);
        if (project?.mouthBlobKey && project.mouthBlobKey !== project.vocalBlobKey) {
          blobs.delete(project.mouthBlobKey);
        }
        projects.delete(id);
      };
      request.onerror = () => tx.abort();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(storageError(tx.error));
      tx.onabort = () => reject(storageError(tx.error));
    });
  });
}

type ProjectBackupV1 = {
  format: 'trap-vani-project-backup';
  version: 1;
  exportedAt: number;
  project: TrapProject;
  vocalAudio: { mimeType: string; base64: string } | null;
  mouthAudio: { mimeType: string; base64: string } | null;
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler uma gravação para a cópia de segurança.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) {
        reject(new Error('Formato de gravação inválido para a cópia de segurança.'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  if (typeof base64 !== 'string' || base64.length > 140 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('A cópia contém dados de áudio inválidos ou demasiado grandes.');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

/** Exporta um projeto completo, incluindo as gravações vocais e beatbox associadas. */
export async function createProjectBackup(project: TrapProject): Promise<Blob> {
  const [vocalBlob, mouthBlob] = await Promise.all([
    project.vocalBlobKey ? getAudioBlob(project.vocalBlobKey) : Promise.resolve(null),
    project.mouthBlobKey ? getAudioBlob(project.mouthBlobKey) : Promise.resolve(null),
  ]);
  if (project.vocalBlobKey && !vocalBlob) throw new Error('A gravação vocal deste projeto não foi encontrada. A cópia foi cancelada.');
  if (project.mouthBlobKey && !mouthBlob) throw new Error('A gravação de beatbox deste projeto não foi encontrada. A cópia foi cancelada.');

  const backup: ProjectBackupV1 = {
    format: 'trap-vani-project-backup',
    version: 1,
    exportedAt: Date.now(),
    project,
    vocalAudio: vocalBlob ? { mimeType: vocalBlob.type, base64: await blobToBase64(vocalBlob) } : null,
    mouthAudio: mouthBlob ? { mimeType: mouthBlob.type, base64: await blobToBase64(mouthBlob) } : null,
  };
  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

/** Restaura um backup como um projeto novo, sem sobrescrever o projeto atual. */
export async function restoreProjectBackup(file: File): Promise<TrapProject> {
  if (!file || file.size <= 0 || file.size > 150 * 1024 * 1024) {
    throw new Error('O ficheiro de cópia deve ter conteúdo e não pode ultrapassar 150 MB.');
  }
  let raw: unknown;
  try { raw = JSON.parse(await file.text()); } catch {
    throw new Error('Este ficheiro não contém uma cópia de segurança válida do TRAP VANI AI.');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Estrutura de cópia de segurança inválida.');
  const backup = raw as Partial<ProjectBackupV1>;
  if (backup.format !== 'trap-vani-project-backup' || backup.version !== 1 || !backup.project || typeof backup.project !== 'object') {
    throw new Error('Formato ou versão de cópia de segurança não reconhecidos.');
  }
  const source = backup.project;
  if (typeof source.name !== 'string' || typeof source.bpm !== 'number' || !source.beatPattern || typeof source.beatPattern !== 'object') {
    throw new Error('Os dados principais do projeto estão incompletos.');
  }
  const vocalBlob = backup.vocalAudio ? base64ToBlob(backup.vocalAudio.base64, backup.vocalAudio.mimeType) : null;
  const mouthBlob = backup.mouthAudio ? base64ToBlob(backup.mouthAudio.base64, backup.mouthAudio.mimeType) : null;
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `restored_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const restored: TrapProject = {
    ...source,
    id,
    name: `${source.name.slice(0, 70)} (Restaurado)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    vocalBlobKey: vocalBlob ? `${id}_vocal` : null,
    mouthBlobKey: mouthBlob ? `${id}_mouth` : null,
  };
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(['projects', 'blobs'], 'readwrite');
      closeDbWhenTransactionEnds(tx, db);
      tx.objectStore('projects').add(restored);
      if (vocalBlob && restored.vocalBlobKey) tx.objectStore('blobs').put(vocalBlob, restored.vocalBlobKey);
      if (mouthBlob && restored.mouthBlobKey) tx.objectStore('blobs').put(mouthBlob, restored.mouthBlobKey);
    } catch (error) {
      db.close();
      reject(storageError(error instanceof DOMException ? error : null));
      return;
    }
    tx.oncomplete = () => resolve(restored);
    tx.onerror = () => reject(storageError(tx.error));
    tx.onabort = () => reject(storageError(tx.error));
  });
}

export async function listCustom808s(): Promise<Sample808[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('custom808s', 'readonly');
    closeDbWhenTransactionEnds(tx, db);
    const req = tx.objectStore('custom808s').getAll();
    req.onsuccess = () => {
      const raw = (req.result as Sample808[]) || [];
      const normalized = raw.map((s) => {
        const mainCat = s.category || s.style || 'Importado pelo Artista';
        return {
          ...s,
          category: mainCat,
          categories:
            Array.isArray(s.categories) && s.categories.length > 0
              ? s.categories
              : [mainCat],
          style: s.style || mainCat,
          sonority: s.sonority || 'Personalizado',
          packId: s.packId || 'pack_imported_phone',
          packName: s.packName || 'Importados do Dispositivo',
          tags: Array.isArray(s.tags) ? s.tags : ['importado', 'próprio'],
          fileHash: s.fileHash,
          available: true,
        };
      });
      resolve(normalized);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveCustom808(sample: Sample808): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('custom808s', 'readwrite');
    closeDbWhenTransactionEnds(tx, db);
    tx.objectStore('custom808s').put(sample);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError(tx.error));
    tx.onabort = () => reject(tx.error || new Error('A operação no armazenamento local foi interrompida.'));
  });
}

export async function deleteCustom808(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['custom808s', 'blobs'], 'readwrite');
    closeDbWhenTransactionEnds(tx, db);
    const samples = tx.objectStore('custom808s');
    const blobs = tx.objectStore('blobs');
    const request = samples.get(id);
    request.onsuccess = () => {
      const sample = request.result as Sample808 | undefined;
      if (sample?.audioBlobKey) blobs.delete(sample.audioBlobKey);
      samples.delete(id);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError(tx.error));
    tx.onabort = () => reject(storageError(tx.error));
  });
}

export async function listCustomPacks808(): Promise<Pack808[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('packs808', 'readonly');
    closeDbWhenTransactionEnds(tx, db);
    const req = tx.objectStore('packs808').getAll();
    req.onsuccess = () => {
      const packs = (req.result as Pack808[]) || [];
      packs.sort((a, b) => b.createdAt - a.createdAt);
      resolve(packs);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveCustomPack808(pack: Pack808): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('packs808', 'readwrite');
    closeDbWhenTransactionEnds(tx, db);
    tx.objectStore('packs808').put(pack);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError(tx.error));
    tx.onabort = () => reject(tx.error || new Error('A operação no armazenamento local foi interrompida.'));
  });
}

export async function deleteCustomPack808(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['packs808', 'custom808s', 'blobs'], 'readwrite');
    closeDbWhenTransactionEnds(tx, db);
    const packs = tx.objectStore('packs808');
    const samples = tx.objectStore('custom808s');
    const blobs = tx.objectStore('blobs');
    const request = samples.getAll();
    request.onsuccess = () => {
      for (const sample of (request.result as Sample808[])) {
        if (sample.packId !== id) continue;
        if (sample.audioBlobKey) blobs.delete(sample.audioBlobKey);
        samples.delete(sample.id);
      }
      packs.delete(id);
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(storageError(tx.error));
    tx.onabort = () => reject(storageError(tx.error));
  });
}

export function createEmptySteps(count: 32 | 64 = 32): BeatStep[] {
  return Array.from({ length: count }, () => ({ active: false, velocity: 0.85 }));
}

export function createStarterPattern(bpm = 140): BeatPattern {
  return createStyleTrapBeat('trap_americano', bpm, 'C', 'minor', true);
}

export function createDefaultMixer(): MixerChannels {
  const base = (volume: number) => ({
    volume,
    pan: 0,
    mute: false,
    solo: false,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
  });
  return {
    vocal: base(0.96),
    '808': base(0.86),
    kick: base(0.88),
    snare: base(0.84),
    clap: base(0.72),
    hihat: base(0.66),
    openhat: base(0.54),
    perc: base(0.56),
    melody: base(0.54),
  };
}

export function createDefaultProject(name = 'Novo Projeto TRAP'): TrapProject {
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    mode: 'auto',
    bpm: 140,
    key: 'C',
    scale: 'minor',
    vocalBlobKey: null,
    vocalFileName: null,
    vocalDurationSec: 0,
    vocalDsp: null,
    vocalAnalysis: null,
    mouthBlobKey: null,
    mouthDurationSec: 0,
    selected808Id: '808_trap_americano',
    lock808Selection: true,
    auto808Mode: false,
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
    beatPattern: createStarterPattern(140),
    autotune: {
      enabled: true,
      retuneSpeedMs: 18,
      mix: 0.85,
      humanize: 0.2,
      key: 'C',
      scale: 'minor',
      preserveFormants: false,
    },
    vocalFx: {
      gainDb: 1.5,
      compression: 0.45,
      reverb: 0.18,
      delay: 0.12,
      deEsser: 0.3,
      offsetMs: 0,
    },
    mixer: createDefaultMixer(),
    master: {
      limiterEnabled: true,
      clipperDrive: 0.12,
      outputGain: 0.92,
    },
    coverArtDataUrl: null,
    chatHistory: [
      {
        id: 'welcome_msg',
        role: 'assistant',
        text: 'Bem-vindo ao estúdio TRAP VANI AI. Grave ou importe a sua voz, escolha um 808 na biblioteca (ou crie um beat com a boca) e diga em português o estilo que pretende.',
        timestamp: now,
      },
    ],
  };
}

export function audioBufferToCompactWavBase64(
  buffer: AudioBuffer,
  maxDurationSec = 35
): { base64: string; mimeType: string } {
  const targetRate = 16000;
  const duration = Math.min(buffer.duration, maxDurationSec);
  const targetLength = Math.max(1, Math.floor(duration * targetRate));
  const srcRate = buffer.sampleRate;
  const ratio = srcRate / targetRate;

  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  const pcm16 = new Int16Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const srcIdx = Math.min(ch0.length - 1, Math.floor(i * ratio));
    const sample = ch1 ? (ch0[srcIdx] + ch1[srcIdx]) * 0.5 : ch0[srcIdx];
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  const wavBuffer = new ArrayBuffer(44 + pcm16.byteLength);
  const view = new DataView(wavBuffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm16.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm16.byteLength, true);

  new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcm16.buffer));

  const bytes = new Uint8Array(wavBuffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    base64: btoa(binary),
    mimeType: 'audio/wav',
  };
}
