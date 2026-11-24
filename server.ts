import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import { sanitizeAndStructureTrapBeat } from './src/audio/trapArranger';
import type { BeatTrackId } from './src/types/studio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Chave GEMINI_API_KEY não configurada no servidor. Configure a chave nas definições do ambiente.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number })?.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function formatApiError(err: unknown): { status: number; message: string } {
  const e = err as { status?: number; message?: string; code?: string };
  const raw = typeof e?.message === 'string' ? e.message : '';
  const status = typeof e?.status === 'number' ? e.status : 500;

  if (raw.includes('GEMINI_API_KEY não configurada')) {
    return { status: 503, message: 'A chave da Gemini ainda não foi configurada no servidor. O administrador deve adicionar GEMINI_API_KEY nas definições do ambiente.' };
  }
  if (status === 403 || raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message:
        'Acesso negado pela API Gemini. Verifique a chave GEMINI_API_KEY no painel Settings > Secrets.',
    };
  }
  if (status === 404 || /model.*not found|not supported for generatecontent/i.test(raw)) {
    return { status: 503, message: 'O modelo de IA configurado não está disponível para esta operação. É necessária uma atualização da configuração do servidor.' };
  }
  if (status === 429 || raw.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Limite de utilização da API atingido ou modelo pago selecionado sem chave faturada em Settings > Secrets.',
    };
  }
  if (status === 400 || status === 413) {
    return { status, message: 'Os dados enviados para a IA são inválidos ou demasiado grandes. Verifique a gravação e tente novamente.' };
  }
  if (status === 503 || status === 504 || /timeout|timed out|aborted/i.test(raw)) {
    return { status: 503, message: 'A IA demorou demasiado tempo a responder. Verifique a ligação e tente novamente.' };
  }
  // Do not expose provider internals, request IDs, stack traces, or secrets to clients.
  return { status: 502, message: 'Não foi possível concluir a operação com a IA. Tente novamente dentro de alguns instantes.' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseGeminiJson<T extends Record<string, unknown>>(response: { text?: string | null }, label: string): T {
  const text = response.text?.trim();
  if (!text) throw new Error(`Resposta vazia da IA (${label}).`);
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error('A resposta JSON não é um objeto.');
    return parsed as T;
  } catch {
    throw new Error(`A IA devolveu uma resposta estruturada inválida (${label}).`);
  }
}

const app = express();

// Basic per-process API throttling protects the public Gemini endpoints and
// external sample proxy from accidental loops and simple request floods.
// Keep Express' default trust-proxy setting: never trust arbitrary client
// X-Forwarded-For values for rate-limit identity.
type RateLimitBucket = { count: number; resetAt: number };
const rateLimitBuckets = new Map<string, RateLimitBucket>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS: Array<{ prefix: string; limit: number; windowMs: number }> = [
  { prefix: '/api/ai/cover', limit: 3, windowMs: RATE_WINDOW_MS },
  { prefix: '/api/ai/', limit: 18, windowMs: RATE_WINDOW_MS },
  { prefix: '/api/packs/import-url', limit: 8, windowMs: RATE_WINDOW_MS },
  { prefix: '/api/packs/proxy-audio', limit: 60, windowMs: RATE_WINDOW_MS },
];

const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}, 5 * 60 * 1000);
rateLimitCleanup.unref();

app.use((req: Request, res: Response, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const policy = RATE_LIMITS.find((item) => req.path.startsWith(item.prefix));
  if (!policy) return next();

  const now = Date.now();
  const identity = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `${policy.prefix}:${identity}`;
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + policy.windowMs };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.count += 1;
  res.setHeader('RateLimit-Limit', String(policy.limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, policy.limit - bucket.count)));
  res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count > policy.limit) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    res.status(429).json({ error: 'Muitas operações em pouco tempo. Aguarde alguns minutos e tente novamente.' });
    return;
  }
  next();
});

// Audio is sent as base64. 26 MiB leaves room for JSON metadata while keeping
// a single request from allocating an unbounded amount of memory.
app.use(express.json({ limit: '26mb', strict: true }));
app.use((err: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
  const parseError = err as { type?: string; status?: number };
  if (parseError?.type === 'entity.too.large' || parseError?.status === 413) {
    res.status(413).json({ error: 'O pedido é demasiado grande. Reduza o tamanho da gravação e tente novamente.' });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'O conteúdo enviado não é um JSON válido.' });
    return;
  }
  res.status(400).json({ error: 'Não foi possível interpretar o pedido enviado.' });
});

// Reject null/array/scalar JSON bodies consistently before route destructuring.
app.use('/api/ai', (req: Request, res: Response, next) => {
  if (!isRecord(req.body)) {
    res.status(400).json({ error: 'O pedido deve conter um objeto JSON válido.' });
    return;
  }
  next();
});

const MAX_AI_AUDIO_BYTES = 18 * 1024 * 1024;
const ALLOWED_AI_AUDIO_MIME = new Set([
  'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3',
  'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/flac',
]);

function validateAiAudioPayload(audioBase64: unknown, mimeType: unknown): string | null {
  if (typeof audioBase64 !== 'string' || typeof mimeType !== 'string') {
    return 'Formato de áudio inválido.';
  }
  const normalizedMime = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (!ALLOWED_AI_AUDIO_MIME.has(normalizedMime)) {
    return 'Formato de áudio não suportado para análise.';
  }
  // Accept plain base64 only; data URLs and non-base64 characters are rejected.
  if (!audioBase64 || audioBase64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audioBase64)) {
    return 'Os dados do áudio estão incompletos ou inválidos.';
  }
  const padding = audioBase64.endsWith('==') ? 2 : audioBase64.endsWith('=') ? 1 : 0;
  const decodedBytes = (audioBase64.length / 4) * 3 - padding;
  if (decodedBytes < 64) return 'A gravação é demasiado pequena ou está vazia.';
  if (decodedBytes > MAX_AI_AUDIO_BYTES) return 'A gravação excede o limite de 18 MiB para análise.';
  return null;
}

/** Reads a response incrementally so an untrusted remote server cannot force an
 * unbounded allocation before the size limit is checked. */
/** Runs untrusted manifest URL checks with a small concurrency ceiling.
 * A manifest may contain up to 48 entries; launching all remote checks at once
 * can overload this server, the external host, or exhaust outbound sockets. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    })
  );
  return results;
}

async function readResponseLimited(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Ficheiro demasiado grande (máximo ${maxBytes} bytes).`);
  }
  if (!response.body) throw new Error('Resposta externa sem conteúdo.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Ficheiro demasiado grande (máximo ${maxBytes} bytes).`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function detectAudioFormat(bytes: Buffer): { mime: string; extension: string } | null {
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    return { mime: 'audio/wav', extension: 'wav' };
  }
  if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3') {
    return { mime: 'audio/mpeg', extension: 'mp3' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return { mime: 'audio/mpeg', extension: 'mp3' };
  }
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') {
    return { mime: 'audio/ogg', extension: 'ogg' };
  }
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'fLaC') {
    return { mime: 'audio/flac', extension: 'flac' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    return { mime: 'audio/mp4', extension: 'm4a' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mime: 'audio/webm', extension: 'webm' };
  }
  return null;
}

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
  });
});

/**
 * 1. Analyze Vocal Audio (Gemini 4 Hydrogen multimodal + client DSP metrics)
 * Never changes the artist's voice or lyrics—extracts cadence, pauses, entries, key & BPM.
 */
app.post('/api/ai/analyze-vocal', async (req: Request, res: Response) => {
  try {
    const { audioBase64, mimeType, dspMetrics, available808s } = req.body as {
      audioBase64?: string;
      mimeType?: string;
      dspMetrics?: unknown;
      available808s?: Array<{ id: string; name: string; category: string; character: string }>;
    };

    if (available808s !== undefined && (!Array.isArray(available808s) || available808s.length > 500 || available808s.some((item) => !isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string'))) {
      res.status(400).json({ error: 'A lista de 808 enviada é inválida ou demasiado grande.' });
      return;
    }
    const audioValidationError = validateAiAudioPayload(audioBase64, mimeType);
    if (audioValidationError) {
      res.status(400).json({ error: audioValidationError });
      return;
    }

    const ai = getAiClient();
    const prompt = `És um engenheiro de som e produtor profissional de TRAP.
Analisa esta gravação de voz real do artista juntamente com as métricas DSP medidas no estúdio.
NÃO inventes letras. O artista pode apenas cantarolar, fazer flows ou rimar.
Deves identificar o ritmo real (BPM provável entre 70 e 175), tonalidade, escala, entradas da voz, pausas naturais, perfil de cadência, intensidade e qual o melhor 808 da lista fornecida (sem alterar a escolha manual se o artista já tiver fixado um).

Métricas DSP medidas localmente:
${JSON.stringify(dspMetrics ?? {}, null, 2).slice(0, 20000)}

Biblioteca de 808 disponível:
${JSON.stringify((available808s ?? []).slice(0, 500).map((item) => ({ id: String(item.id).slice(0, 80), name: String(item.name).slice(0, 100), category: String(item.category).slice(0, 60), character: String(item.character).slice(0, 180) })), null, 2)}

Responde estritamente em JSON válido de acordo com o esquema, com explicação clara em português de Portugal/Brasil natural e simples.`;

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              bpm: { type: Type.NUMBER },
              detectedKey: { type: Type.STRING },
              detectedScale: { type: Type.STRING },
              cadence: { type: Type.STRING },
              intensityProfile: { type: Type.STRING },
              recommended808Id: { type: Type.STRING },
              summaryPt: { type: Type.STRING },
            },
            required: [
              'bpm',
              'detectedKey',
              'detectedScale',
              'cadence',
              'intensityProfile',
              'recommended808Id',
              'summaryPt',
            ],
          },
        },
      })
    );

    const parsed = parseGeminiJson(response, 'análise musical');
    res.json({ analysis: parsed });
  } catch (err) {
    const formatted = formatApiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

/**
 * 2. Low-latency Portuguese Natural Language Beat Direction Parser (gemini-3.1-flash-lite)
 */
app.post('/api/ai/parse-direction', async (req: Request, res: Response) => {
  try {
    const { instruction } = req.body as { instruction?: string };
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2000) {
      res.status(400).json({ error: 'Escreva ou diga uma instrução para interpretar.' });
      return;
    }

    const ai = getAiClient();
    const response = await withRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `Interpreta esta instrução opcional de um artista de TRAP em português e converte em regras rígidas de produção musical.
Se o artista disser que NÃO quer melodias, piano ou instrumentos melódicos (ex: "não quero que a música seja melódica", "não quero piano nem melodias", "apenas bateria, baixo e 808"), define allowMelodies=false, allowPiano=false, allowSynths=false.
Se não mencionar melodias, permite apenas o que fizer sentido sem inventar exageros.

Instrução do artista: "${instruction.trim()}"`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              allowMelodies: { type: Type.BOOLEAN },
              allowPiano: { type: Type.BOOLEAN },
              allowSynths: { type: Type.BOOLEAN },
              mood: {
                type: Type.STRING,
                enum: ['dark', 'aggressive', 'melodic', 'minimal', 'bouncy', 'heavy'],
              },
              sub808Intensity: {
                type: Type.STRING,
                enum: ['low', 'medium', 'high', 'extreme'],
              },
              drumDensity: {
                type: Type.STRING,
                enum: ['sparse', 'balanced', 'explosive'],
              },
              hihatStyle: {
                type: Type.STRING,
                enum: ['simple', 'trap_rolls', 'fast'],
              },
              summaryPt: { type: Type.STRING },
            },
            required: [
              'allowMelodies',
              'allowPiano',
              'allowSynths',
              'mood',
              'sub808Intensity',
              'drumDensity',
              'hihatStyle',
              'summaryPt',
            ],
          },
        },
      })
    );

    const parsed = parseGeminiJson(response, 'interpretação da instrução');
    res.json({ constraints: { ...parsed, rawPrompt: instruction.trim() } });
  } catch (err) {
    const formatted = formatApiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

/**
 * 3. Mouth-to-Beat Audio Transcription (Gemini 4 Hydrogen multimodal + measured onsets)
 * Maps real vocal beatbox hits ("bum, bum, tchá, dum, pá, tchá") to real instruments & exact timings.
 */
app.post('/api/ai/mouth-to-beat', async (req: Request, res: Response) => {
  try {
    const { audioBase64, mimeType, detectedHits, estimatedBpm } = req.body as {
      audioBase64?: string;
      mimeType?: string;
      detectedHits?: Array<{
        timeSec: number;
        lowRatio: number;
        midRatio: number;
        highRatio: number;
        peak: number;
      }>;
      estimatedBpm?: number;
    };

    if ((detectedHits !== undefined && (!Array.isArray(detectedHits) || detectedHits.length > 512 || detectedHits.some((hit) => !isRecord(hit) || !Number.isFinite(hit.timeSec) || !Number.isFinite(hit.lowRatio) || !Number.isFinite(hit.midRatio) || !Number.isFinite(hit.highRatio) || !Number.isFinite(hit.peak)))) || (estimatedBpm !== undefined && (!Number.isFinite(estimatedBpm) || estimatedBpm < 40 || estimatedBpm > 220))) {
      res.status(400).json({ error: 'Os dados rítmicos enviados são inválidos ou excedem o limite permitido.' });
      return;
    }
    const audioValidationError = validateAiAudioPayload(audioBase64, mimeType);
    if (audioValidationError) {
      res.status(400).json({ error: audioValidationError });
      return;
    }

    const ai = getAiClient();
    const prompt = `Ouve atentamente esta gravação onde o artista faz um beat de TRAP com a boca (ex: "bum", "dum", "pá", "tchá", pausas e variações).
Também recebeste os instantes exatos (timeSec) e energia espectral (lowRatio, midRatio, highRatio) medidos pelo DSP para cada som.
Mapeia CADA som da boca para o instrumento real de bateria/TRAP mais fiel:
- Sons graves fechados ("bum", "dum", sub longo) -> "808" ou "kick"
- Ataques secos no meio ("pá", "tá", estalo) -> "snare" ou "clap"
- Sons agudos curtos ("tchá", "ts", "tchi") -> "hihat" ou "openhat"
- Outros sons rítmicos -> "perc"

REGRA CRÍTICA: Respeita TODOS os tempos exatos (timeSec), pausas e variações do artista. Não inventes batidas onde o artista fez pausa. Podes devolver eventos com o timeSec exato da lista medida (ou refinado pela escuta do áudio).
BPM estimado: ${estimatedBpm ?? 130}
Eventos medidos pelo DSP (${detectedHits?.length ?? 0} impactos):
${JSON.stringify((detectedHits ?? []).map((hit) => ({ timeSec: hit.timeSec, lowRatio: hit.lowRatio, midRatio: hit.midRatio, highRatio: hit.highRatio, peak: hit.peak })))}`;

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: {
          parts: [
            { inlineData: { mimeType, data: audioBase64 } },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              bpm: { type: Type.NUMBER },
              descriptionPt: { type: Type.STRING },
              events: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    timeSec: { type: Type.NUMBER },
                    instrument: {
                      type: Type.STRING,
                      enum: ['808', 'kick', 'snare', 'clap', 'hihat', 'openhat', 'perc'],
                    },
                    velocity: { type: Type.NUMBER },
                    noteOffset: { type: Type.INTEGER },
                  },
                  required: ['timeSec', 'instrument', 'velocity'],
                },
              },
            },
            required: ['bpm', 'descriptionPt', 'events'],
          },
        },
      })
    );

    const parsed = parseGeminiJson(response, 'beatbox');
    const allowedInstruments = new Set<BeatTrackId>([
      '808', 'kick', 'snare', 'clap', 'hihat', 'openhat', 'perc',
    ]);
    const rawEvents = Array.isArray(parsed.events) ? parsed.events.slice(0, 512) : [];
    const aiEvents = rawEvents.flatMap((event) => {
      if (!isRecord(event)) return [];
      const timeSec = event.timeSec;
      if (typeof timeSec !== 'number' || !Number.isFinite(timeSec) || timeSec < 0 || timeSec > 300 ||
          typeof event.instrument !== 'string' || !allowedInstruments.has(event.instrument as BeatTrackId)) return [];
      const rawVelocity = event.velocity;
      const rawOffset = event.noteOffset;
      return [{
        timeSec,
        instrument: event.instrument as BeatTrackId,
        velocity: typeof rawVelocity === 'number' && Number.isFinite(rawVelocity)
          ? Math.max(0.1, Math.min(1, rawVelocity)) : 0.85,
        noteOffset: typeof rawOffset === 'number' && Number.isInteger(rawOffset)
          ? Math.max(-24, Math.min(24, rawOffset)) : 0,
      }];
    });

    // The DSP, not the generative model, is the source of truth for onset timing.
    // Produce exactly one event for each detected transient; Gemini only labels it.
    // This prevents hallucinated extra hits and preserves the artist's pauses/timing.
    const orderedHits = (detectedHits ?? []).slice(0, 96).filter((hit) =>
      Number.isFinite(hit.timeSec) && hit.timeSec >= 0 && hit.timeSec <= 300
    ).sort((a, b) => a.timeSec - b.timeSec);
    const usedAiEvents = new Set<number>();
    const events = orderedHits.map((hit) => {
      let bestIndex = -1;
      let bestDistance = 0.13;
      aiEvents.forEach((candidate, index) => {
        if (usedAiEvents.has(index)) return;
        const distance = Math.abs(candidate.timeSec - hit.timeSec);
        if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
      });
      const match = bestIndex >= 0 ? aiEvents[bestIndex] : undefined;
      if (bestIndex >= 0) usedAiEvents.add(bestIndex);
      // Deterministic spectral fallback still creates a playable beat if Gemini
      // misses a transient or returns an event too far from the measured onset.
      const fallbackInstrument: BeatTrackId = hit.lowRatio >= 0.48
        ? '808'
        : hit.highRatio >= 0.42 ? 'hihat'
        : hit.midRatio >= 0.42 ? 'snare' : 'perc';
      const instrument = match?.instrument ?? fallbackInstrument;
      return {
        timeSec: hit.timeSec,
        instrument,
        velocity: match?.velocity ?? Math.max(0.2, Math.min(1, hit.peak || 0.75)),
        ...(instrument === '808' ? { noteOffset: match?.noteOffset ?? 0 } : {}),
      };
    });

    const rawBpm = parsed.bpm;
    const bpm = typeof rawBpm === 'number' && Number.isFinite(rawBpm)
      ? Math.max(40, Math.min(220, rawBpm))
      : (estimatedBpm ?? 130);
    const descriptionPt = typeof parsed.descriptionPt === 'string'
      ? parsed.descriptionPt.slice(0, 1200)
      : 'Padrão rítmico convertido a partir da gravação.';
    res.json({ result: { bpm, descriptionPt, events } });
  } catch (err) {
    const formatted = formatApiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

/**
 * 4. Automatic TRAP Beat Generation / Partial Layer Alteration (Gemini 4 Hydrogen)
 * Builds beat around the vocal cadence, pauses, key, chosen 808, and optional constraints.
 */
app.post('/api/ai/generate-beat', async (req: Request, res: Response) => {
  try {
    const {
      bpm,
      key,
      scale,
      selected808,
      vocalDsp,
      constraints,
      regenerateScope,
      existingTracks,
    } = req.body as {
      bpm: number;
      key: string;
      scale: string;
      selected808: { id: string; name: string; category: string; rootNote: number };
      vocalDsp?: { pauses?: Array<{ startSec: number; endSec: number }>; energyCurve?: number[] } | null;
      constraints: {
        allowMelodies: boolean;
        allowPiano: boolean;
        allowSynths: boolean;
        mood: string;
        sub808Intensity: string;
        drumDensity: string;
        hihatStyle: string;
        rawPrompt?: string;
      };
      regenerateScope?: 'all' | 'drums' | 'hihat' | '808' | 'melody';
      existingTracks?: Record<string, unknown>;
    };

    if (!Number.isFinite(bpm) || bpm < 60 || bpm > 200 || typeof key !== 'string' || key.length > 12 || typeof scale !== 'string' || scale.length > 24 || !isRecord(selected808) || typeof selected808.name !== 'string' || !Number.isFinite(selected808.rootNote) || !isRecord(constraints)) {
      res.status(400).json({ error: 'Parâmetros de geração inválidos. Confirme BPM, tonalidade, escala, 808 e regras do artista.' });
      return;
    }
    const ai = getAiClient();
    const scope = ['all', 'drums', 'hihat', '808', 'melody'].includes(regenerateScope || 'all') ? (regenerateScope || 'all') : 'all';
    const allowMelody = Boolean(constraints?.allowMelodies);

    const prompt = `Cria uma sequência profissional de TRAP de 32 passos (2 compassos em semicolcheias, índices 0 a 31) a ${bpm} BPM, tonalidade ${key} ${scale}.
808 escolhido pelo artista (FIXO — constrói o beat à volta deste 808): ${selected808.name} (categoria ${selected808.category}, nota base MIDI ${selected808.rootNote}).

Regras do artista (obrigatórias):
- Permitir melodias/acordes: ${allowMelody ? 'SIM' : 'NÃO (STRICTAMENTE PROIBIDO adicionar notas em melody!)'}
- Clima/Mood: ${constraints?.mood || 'dark'}
- Intensidade de 808: ${constraints?.sub808Intensity || 'high'}
- Densidade da bateria: ${constraints?.drumDensity || 'balanced'}
- Estilo de Hi-Hat: ${constraints?.hihatStyle || 'trap_rolls'}
- Instrução livre: "${constraints?.rawPrompt || 'Nenhuma instrução adicional'}"
- Âmbito desta geração: "${scope}" (se não for 'all', foca-te em criar variações novas para essa camada).

Curva de energia da voz do artista (32 fatias, 0=pausa, 1=voz forte):
${JSON.stringify(vocalDsp?.energyCurve ?? [])}
Respeita o espaço da voz: quando a voz está intensa, evita entupir com melodias; nas pausas da voz podes abrir espaço com fills de hi-hat ou acentos de 808.

Regras técnicas dos 32 passos (0..31):
- Snare/Clap típico de TRAP moderno cai obrigatoriamente nos tempos 8 e 24 (beat 3 em half-time) com no máximo 1-2 ghost notes subtis.
- Kick e 808 devem trabalhar em conjunto com pocket limpo e espaçado (ex: passos 0, 6, 16, 22, nunca amontoando passos 14-15 antes da viragem do compasso e nunca colocando 808 em passos seguidos para não embolar os graves).
- Hi-Hat em colcheias regulares (passos pares) com no máximo 1 a 2 fills/rolls curtos (roll=2 ou 3) bem colocados nos fins de frase (ex: 14, 30) com velocity suave. Open Hat subtil (1-2 impactos por 2 compassos).
- Notas do 808 devem pertencer estritamente à tonalidade ${key} ${scale} em torno da nota base MIDI ${selected808.rootNote} (ex: ${selected808.rootNote - 5}..${selected808.rootNote + 7}).
- Cada passo tem: step (0..31), velocity (0.35..0.96), opcional roll (1, 2, 3, ou 4 para rolls de hi-hat), opcional note (MIDI integer para '808' entre 28..48 e para 'melody' entre 58..74 em notas espaçadas de meio compasso/compasso dentro da escala ${key} ${scale}), opcional slide (boolean para glide de 808).
- Se allowMelodies for false, o array 'melody' DEVE vir vazio [].`;

    const stepSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          step: { type: Type.INTEGER },
          velocity: { type: Type.NUMBER },
          note: { type: Type.INTEGER },
          roll: { type: Type.INTEGER },
          slide: { type: Type.BOOLEAN },
        },
        required: ['step', 'velocity'],
      },
    };

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              swing: { type: Type.NUMBER },
              descriptionPt: { type: Type.STRING },
              tracks: {
                type: Type.OBJECT,
                properties: {
                  '808': stepSchema,
                  kick: stepSchema,
                  snare: stepSchema,
                  clap: stepSchema,
                  hihat: stepSchema,
                  openhat: stepSchema,
                  perc: stepSchema,
                  melody: stepSchema,
                },
                required: ['808', 'kick', 'snare', 'clap', 'hihat', 'openhat', 'perc', 'melody'],
              },
            },
            required: ['swing', 'descriptionPt', 'tracks'],
          },
        },
      })
    );

    const parsed = parseGeminiJson(response, 'geração de beat') as {
      swing?: number;
      descriptionPt?: string;
      tracks?: Partial<Record<BeatTrackId, Array<{ step: number; velocity: number; note?: number; roll?: number; slide?: boolean }>>>;
    };

    const sanitizedTracks = sanitizeAndStructureTrapBeat({
      rawTracks: parsed.tracks ?? {},
      stepsCount: 32,
      key,
      scale,
      rootNote808: selected808?.rootNote || 36,
      allowMelodies: allowMelody,
    });

    const tracksAsStepLists: Record<
      BeatTrackId,
      Array<{ step: number; velocity: number; note?: number; roll?: number; slide?: boolean }>
    > = {
      '808': [],
      kick: [],
      snare: [],
      clap: [],
      hihat: [],
      openhat: [],
      perc: [],
      melody: [],
    };
    (Object.keys(sanitizedTracks) as BeatTrackId[]).forEach((tr) => {
      sanitizedTracks[tr].forEach((st, idx) => {
        if (st.active) {
          tracksAsStepLists[tr].push({
            step: idx,
            velocity: st.velocity,
            note: st.note,
            roll: st.roll,
            slide: st.slide,
          });
        }
      });
    });

    res.json({
      generated: {
        swing: Number.isFinite(parsed.swing) ? Math.max(0, Math.min(0.5, parsed.swing as number)) : 0,
        descriptionPt: parsed.descriptionPt || `Beat Trap estruturado em ${key} ${scale} (${bpm} BPM).`,
        tracks: tracksAsStepLists,
      },
      scope,
      existingPreserved: Boolean(existingTracks),
    });
  } catch (err) {
    const formatted = formatApiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

/**
 * 4b. Recommend 808s based on vocal cadence, BPM, key, mood & constraints
 * NEVER replaces the artist's selected 808 automatically—returns suggestions for explicit authorization.
 */
app.post('/api/ai/recommend-808', async (req: Request, res: Response) => {
  try {
    const {
      bpm,
      key,
      scale,
      mood,
      directionPrompt,
      vocalSummary,
      current808Id,
      available808s,
    } = req.body as {
      bpm?: number;
      key?: string;
      scale?: string;
      mood?: string;
      directionPrompt?: string;
      vocalSummary?: string;
      current808Id?: string;
      available808s?: Array<{
        id: string;
        name: string;
        style: string;
        sonority: string;
        character: string;
        packName: string;
        tags?: string[];
      }>;
    };

    if (!Array.isArray(available808s) || available808s.length === 0 || available808s.length > 500 || available808s.some((item) => !isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string')) {
      res.status(400).json({ error: 'Lista de 808 indisponível.' });
      return;
    }

    const ai = getAiClient();
    const response = await withRetry(() =>
      ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `És um produtor de TRAP. O artista pediu recomendações de 808 da biblioteca abaixo.
NUNCA inventes IDs fora da lista. Escolhe exatamente 3 IDs reais (ou menos se a lista tiver menos de 3) que melhor combinem com o contexto do som, explicando em português simples porquê cada um funciona.

Contexto atual:
- BPM: ${bpm ?? 136}
- Tom: ${key ?? 'C'} ${scale ?? 'minor'}
- Clima/Mood: ${mood ?? 'dark'}
- Instrução do artista: "${directionPrompt || 'Sem instrução específica'}"
- Análise da voz: "${vocalSummary || 'Ainda sem análise vocal'}"
- 808 atualmente escolhido pelo artista: ${current808Id ?? 'nenhum'}

Biblioteca disponível:
${JSON.stringify(available808s)}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summaryPt: { type: Type.STRING },
              recommendations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    sampleId: { type: Type.STRING },
                    reasonPt: { type: Type.STRING },
                  },
                  required: ['sampleId', 'reasonPt'],
                },
              },
            },
            required: ['summaryPt', 'recommendations'],
          },
        },
      })
    );

    const parsed = parseGeminiJson(response, 'recomendação de 808');
    const allowedIds = new Set(available808s.map((sample) => sample.id));
    const rawRecommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
    const seenIds = new Set<string>();
    const recommendations = rawRecommendations.flatMap((item) => {
      if (!isRecord(item) || typeof item.sampleId !== 'string' || typeof item.reasonPt !== 'string') return [];
      if (!allowedIds.has(item.sampleId) || seenIds.has(item.sampleId)) return [];
      seenIds.add(item.sampleId);
      return [{ sampleId: item.sampleId, reasonPt: item.reasonPt.slice(0, 500) }];
    }).slice(0, 3);
    res.json({
      summaryPt: typeof parsed.summaryPt === 'string' ? parsed.summaryPt.slice(0, 1200) : 'Sugestões de 808 compatíveis com o contexto do projeto.',
      recommendations,
    });
  } catch (err) {
    const formatted = formatApiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

/**
 * 5. Multi-turn Trap Producer Assistant Chat (gemini-3.8-flash or fast gemini-3.1-flash-lite)
 */
app.post('/api/ai/chat', async (req: Request, res: Response) => {
  try {
    const { history, message, studioContext, fastMode } = req.body as {
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      message?: string;
      studioContext?: Record<string, unknown>;
      fastMode?: boolean;
    };

    if (typeof message !== 'string' || !message.trim() || message.length > 8000) {
      res.status(400).json({ error: 'Mensagem vazia.' });
      return;
    }

    const ai = getAiClient();
    const modelName = fastMode ? 'gemini-3.1-flash-lite' : 'gemini-3.8-flash';

    const safeStudioContext = JSON.stringify(studioContext ?? {}).slice(0, 12000);
    const systemInstruction = `És o Engenheiro de Som e Produtor Principal do estúdio TRAP VANI AI.
Falas exclusivamente em português simples, claro e direto (sem jargão exagerado).
Nunca inventes resultados nem digas que aplicaste algo se o utilizador tiver de clicar num botão do estúdio — explica sempre o que o artista pode ajustar na mesa de mistura, autotune, biblioteca de 808 ou gerador de beats.
Contexto atual do projeto aberto no estúdio:
${safeStudioContext}`;

    const safeHistory = Array.isArray(history) ? history.filter((m) => isRecord(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string').slice(-12).map((m) => ({ role: m.role, text: (m.text as string).slice(0, 4000) })) : [];
    const contents = [
      ...safeHistory.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.text }],
      })),
      { role: 'user', parts: [{ text: message.trim() }] },
    ];

    const response = await withRetry(() =>
      ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction,
        },
      })
    );

    res.json({
      reply: response.text ?? 'Sem resposta do assistente.',
      modelUsed: modelName,
    });
  } catch (err) {
    const formatted = formatApiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

/**
 * 6. Cover Art Generation (gemini-3-pro-image with 1K, 2K, 4K)
 * Surfaces genuine API error if user has not configured a paid API key.
 */
app.post('/api/ai/cover', async (req: Request, res: Response) => {
  try {
    const { prompt, imageSize } = req.body as {
      prompt?: string;
      imageSize?: '1K' | '2K' | '4K';
    };

    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1500) {
      res.status(400).json({ error: 'Descreva a capa do seu som antes de gerar.' });
      return;
    }

    const validSize = imageSize === '2K' || imageSize === '4K' ? imageSize : '1K';
    const ai = getAiClient();

    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image',
      contents: {
        parts: [
          {
            text: `Professional square album cover art for a modern TRAP music single. ${prompt.trim()}. Clean editorial composition, dramatic studio lighting, no text or watermarks unless requested.`,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: '1:1',
          imageSize: validSize,
        },
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType ?? 'image/png';
        res.json({
          imageUrl: `data:${mime};base64,${part.inlineData.data}`,
          imageSize: validSize,
        });
        return;
      }
    }

    res.status(502).json({
      error: 'O modelo não devolveu nenhuma imagem nesta tentativa.',
    });
  } catch (err) {
    const formatted = formatApiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

/**
 * 7. External Licensed 808 Pack Manifest Importer & Verified Audio Proxy
 * Allows loading external sample pack JSON manifests while strictly validating URLs & real audio headers.
 */
function ipv4ToNumber(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) return true;
  const ranges: Array<[number, number]> = [
    [0x00000000, 8], // this network
    [0x0a000000, 8], // private
    [0x64400000, 10], // carrier-grade NAT
    [0x7f000000, 8], // loopback
    [0xa9fe0000, 16], // link-local
    [0xac100000, 12], // private
    [0xc0000000, 24], // protocol assignments
    [0xc0000200, 24], // documentation
    [0xc0586300, 24], // 6to4 relay anycast
    [0xc0a80000, 16], // private
    [0xc6120000, 15], // benchmarking
    [0xc6336400, 24], // documentation
    [0xcb007100, 24], // documentation
    [0xe0000000, 4], // multicast
    [0xf0000000, 4], // reserved/broadcast
  ];
  return ranges.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

function parseIpv6(address: string): bigint | null {
  if (isIP(address) !== 6) return null;
  let input = address.toLowerCase().split('%')[0];
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const ipv4 = ipv4ToNumber(input.slice(lastColon + 1));
    if (ipv4 === null) return null;
    input = `${input.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.reduce((value, part) => (value << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version !== 6) return true;
  const value = parseIpv6(address);
  if (value === null) return true;
  const mappedPrefix = 0xffffn << 32n;
  if ((value >> 32n) === 0xffffn) {
    const mappedV4 = Number(value & 0xffffffffn);
    const dotted = [24, 16, 8, 0].map((shift) => (mappedV4 >>> shift) & 255).join('.');
    return isBlockedIpv4(dotted);
  }
  // Only globally routable unicast (2000::/3) is accepted. This excludes
  // loopback, link-local, unique-local, unspecified, multicast and IPv4-compatible ranges.
  const globalUnicast = (value >> 125n) === 1n;
  const documentation = (value >> 64n) === 0x20010db800000000n;
  return !globalUnicast || documentation || (value & mappedPrefix) === mappedPrefix;
}

async function assertSafeExternalHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('URL inválida. Indique um endereço http:// ou https:// completo.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Apenas URLs HTTP ou HTTPS são permitidas.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs com credenciais incorporadas não são permitidas.');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Endereço de rede local ou privado não permitido por segurança.');
  }

  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error('Endereço de rede local, reservado ou privado não permitido por segurança.');
    }
    return parsed;
  }

  // Reject hostnames that resolve to ANY non-public address. This also blocks
  // common DNS-based SSRF targets; a DNS-pinning transport is still needed to
  // eliminate the residual DNS-rebinding race between lookup and fetch.
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error('O domínio resolve para uma rede local, reservada ou privada e foi bloqueado.');
  }
  return parsed;
}

/**
 * Performs the outbound request using the exact public IP resolved immediately
 * before connecting. This closes the DNS-rebinding gap that exists when a URL
 * is validated with DNS lookup and then passed to fetch(), which resolves it a
 * second time independently. TLS still uses the original hostname for SNI and
 * certificate verification.
 */
async function fetchPinnedExternal(
  target: URL,
  init: { method?: 'GET' | 'HEAD'; headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<globalThis.Response> {
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let pinnedAddress: string;
  let family: number;

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('Endereço de rede local, reservado ou privado não permitido por segurança.');
    pinnedAddress = hostname;
    family = isIP(hostname);
  } else {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
      throw new Error('O domínio resolve para uma rede local, reservada ou privada e foi bloqueado.');
    }
    pinnedAddress = addresses[0].address;
    family = addresses[0].family;
  }

  if (init.signal?.aborted) throw new Error('Pedido externo cancelado.');
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const request = transport({
      protocol: target.protocol,
      hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers: init.headers,
      signal: init.signal,
      // The socket connects to the validated address, never a second DNS result.
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
        callback(null, pinnedAddress, family);
      }) as never,
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else headers.set(name, value);
      }
      const status = incoming.statusCode || 502;
      const body = init.method === 'HEAD' || status === 204 || status === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new globalThis.Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers,
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

app.post('/api/packs/import-url', async (req: Request, res: Response) => {
  try {
    const { manifestUrl } = req.body as { manifestUrl?: string };
    if (!manifestUrl || !manifestUrl.trim()) {
      res.status(400).json({ error: 'Indique o URL do ficheiro JSON do pacote de 808.' });
      return;
    }

    const baseUrl = await assertSafeExternalHttpUrl(manifestUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let manifestJson: unknown;
    try {
      const resp = await fetchPinnedExternal(baseUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (resp.status >= 300 && resp.status < 400) {
        res.status(400).json({ error: 'O manifesto redirecionou para outro endereço. Por segurança, redirecionamentos não são permitidos.' });
        return;
      }
      if (!resp.ok) {
        res.status(400).json({
          error: `O servidor externo respondeu com erro ${resp.status} ao carregar o manifesto.`,
        });
        return;
      }
      const manifestBytes = await readResponseLimited(resp, 2 * 1024 * 1024);
      manifestJson = JSON.parse(manifestBytes.toString('utf8'));
    } finally {
      clearTimeout(timer);
    }

    const obj = manifestJson as {
      name?: string;
      description?: string;
      style?: string;
      license?: string;
      samples?: Array<{
        name?: string;
        audioUrl?: string;
        url?: string;
        category?: string;
        sonority?: string;
        rootNote?: number;
        character?: string;
        tags?: string[];
      }>;
    };

    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.samples) || obj.samples.length === 0) {
      res.status(400).json({
        error: 'Manifesto inválido: é necessário um objeto JSON com "name" e array "samples" não vazio.',
      });
      return;
    }

    const packName = String(obj.name || 'Pacote Externo Licenciado').trim().slice(0, 80);
    const packDescription = String(
      obj.description || 'Pacote externo de 808 importado a partir de manifesto JSON.'
    )
      .trim()
      .slice(0, 220);
    const packStyle = String(obj.style || 'Trap Americano Moderno').trim().slice(0, 60);
    const packLicense = String(obj.license || 'Licença Externa Declarada no Manifesto')
      .trim()
      .slice(0, 100);

    const capped = obj.samples.slice(0, 48);
    const verifiedSamples: Array<{
      name: string;
      audioUrl: string;
      category: string;
      sonority: string;
      rootNote: number;
      character: string;
      tags: string[];
    }> = [];
    const failedUrls: string[] = [];

    await mapWithConcurrency(capped, 4, async (item, idx) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          failedUrls.push(`Item #${idx + 1} inválido`);
          return;
        }
        const rawSampleUrl = item.audioUrl || item.url;
        if (!rawSampleUrl || typeof rawSampleUrl !== 'string') {
          failedUrls.push(`Item #${idx + 1} sem audioUrl`);
          return;
        }
        try {
          const resolved = await assertSafeExternalHttpUrl(new URL(rawSampleUrl, baseUrl).toString());
          const headCtrl = new AbortController();
          const headTimer = setTimeout(() => headCtrl.abort(), 5000);
          try {
            let check = await fetchPinnedExternal(resolved, {
              method: 'HEAD',
                    signal: headCtrl.signal,
            });
            if (check.status === 405 || check.status === 501) {
              check = await fetchPinnedExternal(resolved, {
                method: 'GET',
                headers: { Range: 'bytes=0-64' },
                        signal: headCtrl.signal,
              });
            }
            if (!check.ok) {
              failedUrls.push(`${item.name || resolved.pathname} (HTTP ${check.status})`);
              return;
            }
            const ctype = (check.headers.get('content-type') || '').toLowerCase();
            if (ctype.includes('text/html') || ctype.includes('application/json')) {
              failedUrls.push(`${item.name || resolved.pathname} (não é ficheiro de áudio)`);
              return;
            }
            verifiedSamples.push({
              name: String(item.name || `808 Externo ${idx + 1}`).trim().slice(0, 80),
              audioUrl: resolved.toString(),
              category: String(item.category || packStyle).trim().slice(0, 60),
              sonority: String(item.sonority || 'Sample Externo Verificado').trim().slice(0, 60),
              rootNote:
                typeof item.rootNote === 'number' && item.rootNote >= 24 && item.rootNote <= 60
                  ? Math.round(item.rootNote)
                  : 36,
              character: String(
                item.character || `Sample externo verificado (${resolved.hostname}).`
              )
                .trim()
                .slice(0, 180),
              tags: Array.isArray(item.tags)
                ? item.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
                : ['externo', 'licenciado'],
            });
          } finally {
            clearTimeout(headTimer);
          }
        } catch {
          const safeName = typeof item.name === 'string' ? item.name : rawSampleUrl;
          failedUrls.push(String(safeName).slice(0, 160));
        }
      });

    if (verifiedSamples.length === 0) {
      res.status(400).json({
        error:
          'Nenhum ficheiro de áudio válido foi encontrado nas ligações deste manifesto.',
        failedUrls,
      });
      return;
    }

    res.json({
      pack: {
        name: packName,
        description: packDescription,
        style: packStyle,
        license: packLicense,
      },
      samples: verifiedSamples,
      skippedCount: failedUrls.length,
    });
  } catch (err) {
    res.status(400).json({
      error:
        err instanceof Error
          ? err.message
          : 'Erro ao validar o manifesto externo de 808.',
    });
  }
});

app.get('/api/packs/proxy-audio', async (req: Request, res: Response) => {
  try {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Parâmetro url em falta.' });
      return;
    }
    const target = await assertSafeExternalHttpUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const upstream = await fetchPinnedExternal(target, { signal: controller.signal });
      if (upstream.status >= 300 && upstream.status < 400) {
        res.status(400).json({ error: 'O endereço do áudio redirecionou para outro servidor. Por segurança, redirecionamentos não são permitidos.' });
        return;
      }
      if (!upstream.ok) {
        res.status(upstream.status).json({ error: `Erro HTTP ${upstream.status} ao obter áudio.` });
        return;
      }
      const declaredType = (upstream.headers.get('content-type') || '').toLowerCase();
      if (declaredType.includes('text/html') || declaredType.includes('application/json')) {
        res.status(400).json({ error: 'O endereço devolveu texto/HTML em vez de um ficheiro de áudio.' });
        return;
      }
      let audioBytes: Buffer;
      try {
        audioBytes = await readResponseLimited(upstream, 15 * 1024 * 1024);
      } catch (error) {
        res.status(413).json({ error: error instanceof Error ? error.message : 'Áudio demasiado grande.' });
        return;
      }
      if (audioBytes.length < 64) {
        res.status(400).json({ error: 'Ficheiro de áudio demasiado pequeno ou incompleto (mínimo 64 bytes).' });
        return;
      }
      const format = detectAudioFormat(audioBytes);
      if (!format) {
        res.status(415).json({ error: 'Formato de áudio não reconhecido. São aceites WAV, MP3, OGG, FLAC, M4A e WebM.' });
        return;
      }
      res.setHeader('Content-Type', format.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', String(audioBytes.length));
      res.send(audioBytes);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Erro ao transferir sample externo.',
    });
  }
});

async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`TRAP VANI AI server listening on http://0.0.0.0:${PORT}`);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error('Falha ao iniciar o servidor TRAP VANI AI:', error.message);
    process.exitCode = 1;
  });
}

startServer().catch((error: unknown) => {
  console.error('Não foi possível preparar o servidor TRAP VANI AI:', error);
  process.exitCode = 1;
});
