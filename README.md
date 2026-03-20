# PrivateScribe

<p>
  <a href="https://oli-zr.github.io/private.scribe/"><img alt="Open PrivateScribe" src="https://img.shields.io/badge/Open%20PrivateScribe-Live%20Demo-6366f1?style=for-the-badge"></a>
</p>

**Live app:** https://oli-zr.github.io/private.scribe/

PrivateScribe is a local-first note-taking and transcription app that runs entirely in the browser. You can record audio, import existing files, transcribe them with Whisper, and keep transcripts and notes in a folder you choose on your own machine.

There is no backend, no build step, and no account setup.

## Features

- Record audio in the browser (microphone or shared tab/window/system audio)
- Import existing audio files
- Transcribe locally with Whisper (`small` or `medium`)
- Keep transcripts and notes per session
- Search and filter saved sessions
- Export transcripts and notes as `.txt`, `.md`, or `.json`
- Play back or delete the original audio file
- Dark and light theme support

## Browser support

PrivateScribe depends on the File System Access API, so it is intended for Chromium-based browsers such as Chrome, Brave, or Arc.

Safari is not supported.

For desktop/app audio capture, your browser also needs `getDisplayMedia` audio sharing support. In Chromium browsers this typically means choosing a tab, app window, or an entire screen in the share dialog and explicitly enabling the audio-sharing checkbox. Depending on the browser and operating system, app audio such as Zoom or a YouTube desktop app may only be available when sharing the corresponding window or the full screen.

## Running locally

This project is a static web app. Serve the repository over HTTP rather than opening `index.html` directly.

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

If you prefer, any other static file server will do.

## How it works

- `index.html` and `style.css` provide the UI
- `app.js` handles recording, sessions, export, and the overall app flow
- `transcribe.js` decodes audio and talks to the worker
- `worker.js` runs Whisper through Transformers.js in a Web Worker
- `storage.js` handles the File System Access API and IndexedDB

On first use, the selected Whisper model is downloaded and cached by the browser. After that, transcription can continue without downloading the model again.

## Data storage

PrivateScribe stores data in two places:

1. **Your chosen working folder**
   - `index.json`
   - during saves, a short-lived recovery file `index.json.tmp`
   - one folder per session
   - session files such as `audio.webm`, `audio.mp3`, `audio.wav`, `transcript.txt`, `notes.txt`, and `meta.json`

2. **IndexedDB in the browser**
   - stores the handle to the selected working folder so the app can restore it later

## Notes on privacy

Audio, transcripts, and notes stay in your local working folder. The app does not require its own server for transcription.

The only network-dependent part is the initial download of the Whisper model and runtime assets.



## License

See [`LICENSE`](./LICENSE).
