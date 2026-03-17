/**
 * transcribe.js – Whisper Worker verwalten + Audio dekodieren
 *
 * Flow:
 *  1. Audio-Blob (webm) → AudioContext → Float32Array @ 16 kHz
 *  2. Float32Array per Transferable an Worker übergeben (kein Kopieren)
 *  3. Worker schickt Status-Updates + finales Transkript zurück
 */

let worker = null;

function ensureWorker() {
  if (!worker) {
    // Module Worker: Transformers.js kann ESM-Imports nutzen
    worker = new Worker('./worker.js', { type: 'module' });
  }
  return worker;
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
export function transcribeAudio(audioBlob, modelSize, onStatus) {
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

      // Float32Array als Transferable übergeben (kein Kopieren der ~100-900 MB)
      const transferBuffer = audioData.buffer;
      w.postMessage(
        { type: 'transcribe', audio: audioData, sampleRate: 16000, modelSize },
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
export function warmUpWorker() {
  ensureWorker();
}
