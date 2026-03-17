/**
 * worker.js – Whisper-Transkription im Web Worker
 * Läuft komplett lokal via Transformers.js (ONNX/WebAssembly)
 * Kein Server, keine Installation nötig.
 */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';

// Modell-Cache im Browser aktivieren (nach 1. Download kein Re-Download)
env.allowLocalModels  = false;
env.useBrowserCache   = true;

let transcriber   = null;
let loadedModelId = null;

self.addEventListener('message', async ({ data }) => {
  if (data.type !== 'transcribe') return;

  const { audio, audioBuffer, sampleRate, modelSize } = data;

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
      sampling_rate:     sampleRate ?? 16000,
      language:          'german',
      task:              'transcribe',
      chunk_length_s:    30,   // lange Aufnahmen in 30s-Chunks
      stride_length_s:   5,
      return_timestamps: false,
    });

    self.postMessage({ type: 'result', text: (result.text ?? '').trim() });

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
});
