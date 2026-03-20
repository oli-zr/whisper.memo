/**
 * transcribe.js – Whisper Worker verwalten + Audio dekodieren
 *
 * Flow:
 *  1. Audio-Blob (webm) → AudioContext → Float32Array @ 16 kHz
 *  2. Float32Array per Transferable an Worker übergeben (kein Kopieren)
 *  3. Worker schickt Status-Updates + finales Transkript zurück
 */

let worker = null;
let workerConfiguredRoot = null;

function ensureWorker() {
  if (!worker) {
    // Module Worker: Transformers.js kann ESM-Imports nutzen
    worker = new Worker('./worker.js', { type: 'module' });
  }
  return worker;
}

export async function configureModelCache(rootDirHandle) {
  const w = ensureWorker();
  if (rootDirHandle === workerConfiguredRoot) return;

  await new Promise((resolve, reject) => {
    const handleMessage = ({ data }) => {
      if (data.type === 'cache-configured') {
        cleanup();
        workerConfiguredRoot = rootDirHandle;
        resolve();
      } else if (data.type === 'cache-error') {
        cleanup();
        reject(new Error(data.message));
      }
    };

    const handleError = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error('Worker-Konfiguration fehlgeschlagen.'));
    };

    const cleanup = () => {
      w.removeEventListener('message', handleMessage);
      w.removeEventListener('error', handleError);
    };

    w.addEventListener('message', handleMessage);
    w.addEventListener('error', handleError, { once: true });
    w.postMessage({ type: 'configure-cache', rootDirHandle });
  });
}

/**
 * Audio-Blob dekodieren → Float32Array @ 16 kHz (Whisper-Eingangsformat)
 * @param {Blob} blob
 * @returns {Promise<Float32Array>}
 */
export async function decodeAudioToFloat32(blob) {
  const arrayBuffer = await blob.arrayBuffer();

  // Direkt auf 16 kHz resampeln – das ist Whispers erwartete Sample-Rate
  const audioCtx    = new AudioContext({ sampleRate: 16000 });
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  // Erster Kanal (Mono) als Float32Array zurückgeben
  return audioBuffer.getChannelData(0);
}

/**
 * Transkription starten
 *
 * @param {Blob}     audioBlob   - Aufnahme-Blob (webm/wav/mp3)
 * @param {'small'|'medium'} modelSize
 * @param {FileSystemDirectoryHandle | null} rootDirHandle
 * @param {function} onStatus    - (status: string, extra?: object) => void
 *   Mögliche Status-Werte:
 *     'decoding'    – Audio wird dekodiert
 *     'loading'     – Whisper-Modell lädt (inkl. Download beim 1. Mal)
 *     'transcribing'– Transkription läuft
 *     'done'        – fertig (text kommt über Promise)
 *     'error'       – Fehler
 *
 * @returns {Promise<string>} Transkriptions-Text
 */
export function transcribeAudio(audioBlob, modelSize, rootDirHandle, onStatus) {
  return new Promise(async (resolve, reject) => {
    let w;

    try {
      onStatus?.('decoding');
      const audioData = await decodeAudioToFloat32(audioBlob);

      w = ensureWorker();

      // Nachrichten-Handler für diesen Job
      const handleMessage = ({ data }) => {
        switch (data.type) {
          case 'status':
            onStatus?.(data.value);
            break;

          case 'download':
            // Download-Fortschritt weiterleiten
            onStatus?.('loading', data.progress);
            break;

          case 'result':
            w.removeEventListener('message', handleMessage);
            onStatus?.('done');
            resolve(data.text);
            break;

          case 'error':
            w.removeEventListener('message', handleMessage);
            onStatus?.('error');
            reject(new Error(data.message));
            break;
        }
      };

      w.addEventListener('message', handleMessage);

      // Nur den Buffer übertragen und im Worker als Float32Array rekonstruieren.
      // Das vermeidet Struktur-/Typ-Probleme beim structured clone.
      const transferBuffer = audioData.buffer;
      w.postMessage(
        { type: 'transcribe', audioBuffer: transferBuffer, sampleRate: 16000, modelSize, rootDirHandle },
        [transferBuffer]
      );

    } catch (err) {
      onStatus?.('error');
      reject(err);
    }
  });
}

/**
 * Worker vorab initialisieren (optional, für schnelleren Start).
 * Wird im Hintergrund gestartet ohne Transkription.
 */
export async function warmUpWorker(rootDirHandle = null) {
  ensureWorker();
  if (rootDirHandle) {
    await configureModelCache(rootDirHandle);
  }
}
