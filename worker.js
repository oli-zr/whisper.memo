/**
 * worker.js – Whisper-Transkription im Web Worker
 * Läuft komplett lokal via Transformers.js (ONNX/WebAssembly)
 * Kein Server, keine Installation nötig.
 */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

const MODEL_CACHE_DIR_NAME = '.privatescribe-models';
const CACHE_INDEX_FILENAME = 'cache-index.json';

// Modell-Cache wird standardmäßig über einen benutzerdefinierten Cache im
// gewählten Arbeitsordner abgelegt. Browser-Cache deaktivieren, damit die
// Modelldateien nicht zusätzlich an einem zweiten Ort landen.
env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = false;
env.customCache = null;

let transcriber = null;
let loadedModelId = null;
let cacheRootDirHandle = null;
let cacheIndex = null;
let cacheIndexDirty = false;
let cacheIndexSavePromise = null;

self.addEventListener('message', async ({ data }) => {
  if (data.type === 'configure-cache') {
    try {
      await configureModelCache(data.rootDirHandle ?? null);
      self.postMessage({ type: 'cache-configured' });
    } catch (err) {
      self.postMessage({ type: 'cache-error', message: err.message });
    }
    return;
  }

  if (data.type !== 'transcribe') return;

  const { audio, audioBuffer, sampleRate, modelSize, rootDirHandle, language } = data;

  if (rootDirHandle) {
    try {
      await configureModelCache(rootDirHandle);
    } catch (err) {
      self.postMessage({ type: 'cache-error', message: err.message });
    }
  }

  // Modell-ID wählen
  const modelId = modelSize === 'medium'
    ? 'Xenova/whisper-medium'
    : 'Xenova/whisper-small';

  try {
    // Modell laden (nur beim ersten Mal oder Modellwechsel)
    if (!transcriber || loadedModelId !== modelId) {
      self.postMessage({ type: 'status', value: 'loading' });

      transcriber = await pipeline(
        'automatic-speech-recognition',
        modelId,
        {
          progress_callback: (p) => {
            // Download-Fortschritt an Haupt-Thread melden
            self.postMessage({ type: 'download', progress: p });
          },
        }
      );

      loadedModelId = modelId;
    }

    // Transkription starten
    self.postMessage({ type: 'status', value: 'transcribing' });

    // Float32Array aus transferiertem Buffer wiederherstellen
    const audioArray = (audioBuffer instanceof ArrayBuffer)
      ? new Float32Array(audioBuffer)
      : ((audio instanceof Float32Array) ? audio : new Float32Array(audio));

    const result = await transcriber(audioArray, {
      sampling_rate: sampleRate ?? 16000,
      language: language || 'german',
      task: 'transcribe',
      chunk_length_s: 30,   // lange Aufnahmen in 30s-Chunks
      stride_length_s: 5,
      return_timestamps: false,
    });

    self.postMessage({ type: 'result', text: (result.text ?? '').trim() });

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
});

async function configureModelCache(rootDirHandle) {
  if (!rootDirHandle) {
    cacheRootDirHandle = null;
    cacheIndex = null;
    env.useCustomCache = false;
    env.customCache = null;
    return;
  }

  const cacheDirHandle = await rootDirHandle.getDirectoryHandle(MODEL_CACHE_DIR_NAME, { create: true });

  if (cacheRootDirHandle && await cacheRootDirHandle.isSameEntry(cacheDirHandle)) {
    env.useCustomCache = true;
    env.customCache = createDirectoryCache(cacheRootDirHandle);
    return;
  }

  cacheRootDirHandle = cacheDirHandle;
  cacheIndex = await readCacheIndex(cacheRootDirHandle);
  cacheIndexDirty = false;
  env.useCustomCache = true;
  env.customCache = createDirectoryCache(cacheRootDirHandle);
}

function createDirectoryCache(rootHandle) {
  return {
    match: async (request) => {
      const url = normalizeRequestUrl(request);
      if (!url) return undefined;

      const entry = await getCacheEntry(rootHandle, url);
      if (!entry) return undefined;

      try {
        const fileHandle = await resolveFileHandle(rootHandle, entry.path);
        const file = await fileHandle.getFile();
        return new Response(file, {
          status: entry.status ?? 200,
          statusText: entry.statusText ?? 'OK',
          headers: entry.headers ?? {},
        });
      } catch {
        await deleteCacheEntry(rootHandle, url);
        return undefined;
      }
    },
    put: async (request, response) => {
      const url = normalizeRequestUrl(request);
      if (!url || !response?.ok) return;

      const clone = response.clone();
      const blob = await clone.blob();
      const targetPath = buildStoragePath(url);
      await writeBlobToPath(rootHandle, targetPath, blob);
      await setCacheEntry(rootHandle, url, {
        path: targetPath,
        status: clone.status,
        statusText: clone.statusText,
        headers: Object.fromEntries(clone.headers.entries()),
        storedAt: new Date().toISOString(),
        size: blob.size,
      });
    },
  };
}

function normalizeRequestUrl(request) {
  try {
    if (typeof request === 'string') return request;
    if (request instanceof URL) return request.toString();
    return request?.url ?? null;
  } catch {
    return null;
  }
}

function buildStoragePath(urlString) {
  const url = new URL(urlString);
  const host = sanitizeSegment(url.host || 'remote');
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map(part => sanitizeSegment(part));

  if (parts.length === 0) parts.push('index');

  const filename = parts.pop();
  const querySuffix = url.search
    ? `__${sanitizeSegment(url.searchParams.toString()).slice(0, 120)}`
    : '';

  return [host, ...parts, `${filename}${querySuffix}`];
}

function sanitizeSegment(value) {
  const normalized = decodeURIComponentSafe(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'file';
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function writeBlobToPath(rootHandle, pathParts, blob) {
  const fileHandle = await ensureFileHandle(rootHandle, pathParts);
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function ensureFileHandle(rootHandle, pathParts) {
  const dirs = pathParts.slice(0, -1);
  const filename = pathParts[pathParts.length - 1];
  let dirHandle = rootHandle;

  for (const dirName of dirs) {
    dirHandle = await dirHandle.getDirectoryHandle(dirName, { create: true });
  }

  return dirHandle.getFileHandle(filename, { create: true });
}

async function resolveFileHandle(rootHandle, pathParts) {
  const dirs = pathParts.slice(0, -1);
  const filename = pathParts[pathParts.length - 1];
  let dirHandle = rootHandle;

  for (const dirName of dirs) {
    dirHandle = await dirHandle.getDirectoryHandle(dirName);
  }

  return dirHandle.getFileHandle(filename);
}

async function readCacheIndex(rootHandle) {
  try {
    const fileHandle = await rootHandle.getFileHandle(CACHE_INDEX_FILENAME);
    const file = await fileHandle.getFile();
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function persistCacheIndex(rootHandle) {
  if (!cacheIndexDirty || !rootHandle) return;
  if (cacheIndexSavePromise) return cacheIndexSavePromise;

  cacheIndexSavePromise = (async () => {
    const fileHandle = await rootHandle.getFileHandle(CACHE_INDEX_FILENAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(cacheIndex, null, 2));
    await writable.close();
    cacheIndexDirty = false;
  })();

  try {
    await cacheIndexSavePromise;
  } finally {
    cacheIndexSavePromise = null;
  }
}

async function getCacheEntry(rootHandle, url) {
  if (!cacheIndex || rootHandle !== cacheRootDirHandle) {
    cacheIndex = await readCacheIndex(rootHandle);
  }
  return cacheIndex[url] ?? null;
}

async function setCacheEntry(rootHandle, url, value) {
  if (!cacheIndex || rootHandle !== cacheRootDirHandle) {
    cacheIndex = await readCacheIndex(rootHandle);
  }
  cacheIndex[url] = value;
  cacheIndexDirty = true;
  await persistCacheIndex(rootHandle);
}

async function deleteCacheEntry(rootHandle, url) {
  if (!cacheIndex || rootHandle !== cacheRootDirHandle) {
    cacheIndex = await readCacheIndex(rootHandle);
  }
  if (!cacheIndex[url]) return;
  delete cacheIndex[url];
  cacheIndexDirty = true;
  await persistCacheIndex(rootHandle);
}
