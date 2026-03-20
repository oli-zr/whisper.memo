/**
 * app.js – PrivateScribe App – Haupt-Logik
 * ES-Modul, kein Build-Schritt nötig.
 * Whisper läuft komplett lokal im Browser via WebAssembly.
 */
import {
  fsaSupported, restoreFolderHandle, dbGet, dbSet,
  getOrCreateDir, writeFile, readFile, readFileAsBlob,
  deleteFile, deleteDir,
} from './storage.js';

import { configureModelCache, transcribeAudio, warmUpWorker } from './transcribe.js';

// ── App-Zustand ────────────────────────────────────────────────────────────────
const S = {
  rootDir:    null,       // FileSystemDirectoryHandle
  sessions:   [],         // Array<SessionObj>
  activeId:   null,       // string | null
  modelSize:  'small',    // 'small' | 'medium'
  theme:      'dark',     // 'dark' | 'light'
  searchQuery: '',
  sessionFilter: 'all',
  recording:  false,
  recordingSource: 'microphone',
  notesPaneWidth: Number(localStorage.getItem('privatescribe-notes-width')) || null,
};

// Hilfsmethoden
const getActive = () => S.sessions.find(s => s.id === S.activeId) ?? null;
const findById  = (id) => S.sessions.find(s => s.id === id) ?? null;

function isInProgressStatus(status) {
  return ['decoding', 'loading', 'transcribing'].includes(status);
}

// ── Persistenz ────────────────────────────────────────────────────────────────
async function loadIndex() {
  const raw = await readFile(S.rootDir, 'index.json');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveIndex() {
  // Nur serialisierbare Felder speichern
  const data = S.sessions.map(({ id, title, createdAt, dirName, transcriptStatus, hasAudio }) =>
    ({ id, title, createdAt, dirName, transcriptStatus, hasAudio })
  );
  await writeFile(S.rootDir, 'index.json', JSON.stringify(data, null, 2));
}

function sessionDirName(session) {
  const date = new Date(session.createdAt).toISOString().slice(0, 10);
  const slug  = (session.title || 'Unbenannt')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 50);
  return `${date}_${slug}`;
}

async function getSessionDir(session) {
  return getOrCreateDir(S.rootDir, session.dirName);
}

async function ensureModelCacheDir() {
  if (!S.rootDir) return;
  await getOrCreateDir(S.rootDir, '.privatescribe-models');
  await configureModelCache(S.rootDir);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  // Präferenzen laden
  S.modelSize = localStorage.getItem('privatescribe-model') || 'small';
  S.theme = localStorage.getItem('privatescribe-theme') || 'dark';
  applyTheme();

  // FSA-Unterstützung prüfen
  if (!fsaSupported()) {
    showBanner('⚠️ Bitte Chrome, Arc oder Brave verwenden – Safari unterstützt die File System API nicht.', 'warning', false);
    showWelcome();
    return;
  }

  // Gespeicherten Ordner wiederherstellen
  S.rootDir = await restoreFolderHandle();

  if (S.rootDir) {
    await initApp();
  } else {
    showWelcome();
  }
}

async function initApp() {
  document.getElementById('welcome-screen').classList.add('hidden');

  await ensureModelCacheDir();

  S.sessions = await loadIndex();
  // Arbeitsspeicher-Felder initialisieren (nicht in index.json)
  S.sessions.forEach(s => {
    if (s.transcript === undefined) s.transcript = undefined; // lazy
    if (s.notes      === undefined) s.notes      = undefined;
    if (!s.downloadProgress)        s.downloadProgress = null;
  });

  S.activeId = null;
  const searchEl = document.getElementById('session-search');
  const filterEl = document.getElementById('session-filter');
  if (searchEl) searchEl.value = S.searchQuery;
  if (filterEl) filterEl.value = S.sessionFilter;
  renderSidebar();
  renderMainArea();
  updateModelSelector();
  updateThemeToggle();

  // Worker vorladen (damit erstes Transkribieren schneller startet)
  await warmUpWorker(S.rootDir);
}


function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  updateThemeToggle();
}

function updateThemeToggle() {
  const btn = document.getElementById('btn-theme-toggle');
  if (!btn) return;
  btn.textContent = S.theme === 'light' ? '☀️ Light Mode' : '🌙 Dark Mode';
}

function toggleTheme() {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('privatescribe-theme', S.theme);
  applyTheme();
}

// ── Welcome Screen ────────────────────────────────────────────────────────────
function showWelcome() {
  document.getElementById('welcome-screen').classList.remove('hidden');
  updateWelcomeModelChoice();
}

function updateWelcomeModelChoice() {
  document.querySelectorAll('.model-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.model === S.modelSize);
  });
}

document.querySelectorAll('.model-option').forEach(opt => {
  opt.addEventListener('click', () => {
    S.modelSize = opt.dataset.model;
    localStorage.setItem('privatescribe-model', S.modelSize);
    updateWelcomeModelChoice();
    updateModelSelector();
  });
});

document.getElementById('btn-choose-folder').addEventListener('click', chooseFolder);

async function chooseFolder() {
  if (!fsaSupported()) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    S.rootDir = handle;
    await dbSet('rootDirHandle', handle);
    await initApp();
  } catch (e) {
    if (e.name !== 'AbortError') {
      showBanner('Ordner konnte nicht geöffnet werden: ' + e.message, 'error');
    }
  }
}

document.getElementById('btn-theme-toggle').addEventListener('click', toggleTheme);
document.getElementById('session-search').addEventListener('input', e => {
  S.searchQuery = e.target.value || '';
  renderSidebar();
});
document.getElementById('session-filter').addEventListener('change', e => {
  S.sessionFilter = e.target.value;
  renderSidebar();
});

const importInputEl = document.getElementById('audio-import-input');
document.getElementById('btn-import-audio').addEventListener('click', () => importInputEl.click());
importInputEl.addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('audio/')) {
    showBanner('Bitte eine gültige Audiodatei auswählen.', 'warning');
    return;
  }
  await createSession(file.name.replace(/\.[^.]+$/, ''), file);
});

document.getElementById('btn-change-folder').addEventListener('click', () => {
  showConfirm(
    'Arbeitsordner wechseln?',
    'Du kannst einen anderen Ordner wählen. Bestehende Sitzungen bleiben erhalten.',
    chooseFolder, 'Wechseln', false
  );
});

// ── Sidebar rendern ───────────────────────────────────────────────────────────
function renderSidebar() {
  const list   = document.getElementById('session-list');
  const query = S.searchQuery.trim().toLowerCase();
  const filtered = S.sessions.filter(s => {
    if (S.sessionFilter === 'done' && s.transcriptStatus !== 'done') return false;
    if (S.sessionFilter === 'error' && s.transcriptStatus !== 'error') return false;
    if (S.sessionFilter === 'idle' && s.transcriptStatus !== 'idle') return false;
    if (S.sessionFilter === 'in-progress' && !isInProgressStatus(s.transcriptStatus)) return false;
    if (!query) return true;
    return [s.title, s.transcript || '', s.notes || '']
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
  const sorted = [...filtered].sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );

  if (sorted.length === 0) {
    const hasFilters = !!query || S.sessionFilter !== 'all';
    list.innerHTML = `<div style="padding:20px 8px;color:var(--text-3);font-size:12px;text-align:center;line-height:1.6">${hasFilters ? 'Keine Treffer für Suche/Filter.' : 'Noch keine Aufnahmen.<br>Klicke auf „＋ Neue Aufnahme".'}</div>`;
    return;
  }

  list.innerHTML = '';
  for (const s of sorted) {
    const isActive = s.id === S.activeId;
    const item     = document.createElement('div');
    item.className = 'session-item' + (isActive ? ' active' : '');
    item.dataset.id = s.id;

    // Status-Badge in der Liste
    let badgeHtml = '';
    if (s.transcriptStatus === 'transcribing' || s.transcriptStatus === 'loading' || s.transcriptStatus === 'decoding') {
      badgeHtml = `<span class="sess-badge transcribing">•••</span>`;
    } else if (s.transcriptStatus === 'error') {
      badgeHtml = `<span class="sess-badge error">!</span>`;
    }

    item.innerHTML = `
      <div class="sess-info">
        <div class="sess-title">${esc(s.title)}</div>
        <div class="sess-date">${fmtDate(s.createdAt)}</div>
      </div>
      ${badgeHtml}
      <button class="sess-menu-btn" title="Optionen" aria-label="Optionen">⋯</button>
    `;

    item.addEventListener('click', e => {
      if (!e.target.closest('.sess-menu-btn')) openSession(s.id);
    });
    item.querySelector('.sess-menu-btn').addEventListener('click', e => {
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, s.id);
    });

    list.appendChild(item);
  }
}

// ── Haupt-Bereich rendern ─────────────────────────────────────────────────────
function renderMainArea() {
  const active = getActive();
  const hasActive = !!active;

  document.getElementById('empty-main').classList.toggle('hidden', hasActive);
  document.getElementById('transcript-col').classList.toggle('hidden', !hasActive);
  document.getElementById('notes-col').classList.toggle('hidden', !hasActive);
  document.getElementById('notes-resizer').classList.toggle('hidden', !hasActive);

  if (!active) return;

  applyNotesPaneWidth();

  // Titel
  document.getElementById('session-title-input').value = active.title || '';

  // Status-Badge
  renderStatusBadge(active);

  // Download-Fortschritt
  renderDownloadProgress(active);

  // Transkript
  const textEl     = document.getElementById('transcript-text');
  const emptyEl    = document.getElementById('transcript-empty');
  const retryEl    = document.getElementById('btn-retry');

  if (active.transcript) {
    textEl.textContent = active.transcript;
    emptyEl.classList.add('hidden');
    retryEl.classList.add('hidden');
  } else if (active.transcriptStatus === 'error') {
    textEl.textContent = '';
    emptyEl.innerHTML = `<div class="big-icon">❌</div><p>Transkription fehlgeschlagen.</p>`;
    emptyEl.classList.remove('hidden');
    retryEl.classList.remove('hidden');
  } else if (['decoding','loading','transcribing'].includes(active.transcriptStatus)) {
    textEl.textContent = '';
    emptyEl.innerHTML = `<div class="big-icon">🔄</div><p>Whisper arbeitet…</p>`;
    emptyEl.classList.remove('hidden');
    retryEl.classList.add('hidden');
  } else {
    textEl.textContent = '';
    emptyEl.innerHTML = `<div class="big-icon">📝</div><p>Transkript erscheint hier nach der Verarbeitung.</p>`;
    emptyEl.classList.remove('hidden');
    retryEl.classList.add('hidden');
  }

  // Notizen
  const notesEl = document.getElementById('notes-textarea');
  notesEl.value = active.notes || '';
  document.getElementById('notes-save-indicator').textContent = '';

  // Audio-Player
  loadAudioPlayer(active);
}

function renderStatusBadge(session) {
  const el = document.getElementById('status-badge');
  const st = session?.transcriptStatus || 'idle';

  const configs = {
    idle:         { cls: 'idle',        html: '' },
    decoding:     { cls: 'decoding',    html: '<span class="spin"></span> Audio dekodiert…' },
    loading:      { cls: 'loading',     html: '<span class="spin"></span> Modell lädt…' },
    transcribing: { cls: 'transcribing',html: '<span class="spin"></span> Transkribiert…' },
    done:         { cls: 'done',        html: '✓ Fertig' },
    error:        { cls: 'error',       html: '✕ Fehler' },
  };

  const cfg = configs[st] || configs.idle;
  el.className  = `status-badge ${cfg.cls}`;
  el.innerHTML  = cfg.html;
}

function renderDownloadProgress(session) {
  const barWrap = document.getElementById('download-progress-bar');
  const fill    = document.getElementById('download-progress-fill');
  const label   = document.getElementById('download-progress-label');
  const p       = session?.downloadProgress;

  if (p && session.transcriptStatus === 'loading') {
    barWrap.classList.remove('hidden');
    label.classList.remove('hidden');
    const pct = typeof p.progress === 'number' ? Math.round(p.progress) : 0;
    fill.style.width   = pct + '%';
    label.textContent  = `⬇ ${p.file || 'Modell'} – ${pct}%`;
  } else {
    barWrap.classList.add('hidden');
    label.classList.add('hidden');
  }
}

// ── Session öffnen ────────────────────────────────────────────────────────────
async function openSession(id) {
  const s = findById(id);
  if (!s) return;

  // Transcript + Notizen lazy laden
  if (s.transcript === undefined) {
    try {
      const dir   = await getSessionDir(s);
      s.transcript = await readFile(dir, 'transcript.txt') ?? '';
      s.notes      = await readFile(dir, 'notes.txt')      ?? '';
    } catch {
      s.transcript = '';
      s.notes      = '';
    }
  }

  S.activeId = id;
  renderSidebar();
  renderMainArea();
}

// ── Audio-Player ──────────────────────────────────────────────────────────────
let audioObjectURL = null;
let audioDurationFallback = 0;

async function loadAudioPlayer(session) {
  const section = document.getElementById('audio-section');
  audioDurationFallback = 0;
  resetAudioUI();
  if (!session?.hasAudio) {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
    section.classList.add('hidden');
    return;
  }

  try {
    const dir  = await getSessionDir(session);
    const file = await readFileAsBlob(dir, 'audio.webm');
    if (!file) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
      section.classList.add('hidden');
      return;
    }

    if (audioObjectURL) URL.revokeObjectURL(audioObjectURL);
    audioObjectURL = URL.createObjectURL(file);
    audioDurationFallback = await getAudioDuration(file);
    audioEl.pause();
    audioEl.src = audioObjectURL;
    audioEl.load();
    updateAudioUI(0, getEffectiveAudioDuration());
    section.classList.remove('hidden');
  } catch {
    audioDurationFallback = 0;
    resetAudioUI();
    section.classList.add('hidden');
  }
}

// Audio-Player Steuerung
const audioEl = document.getElementById('hidden-audio');
const seekEl  = document.getElementById('audio-seek');
const timeEl  = document.getElementById('audio-time');
const currentTimeEl = document.getElementById('audio-current-time');
const durationEl = document.getElementById('audio-duration');
const playEl  = document.getElementById('btn-play-pause');

function getEffectiveAudioDuration() {
  return Number.isFinite(audioEl.duration) && audioEl.duration > 0
    ? audioEl.duration
    : audioDurationFallback;
}

function updateSeekBackground(progress) {
  const pct = `${Math.min(100, Math.max(0, progress))}%`;
  seekEl.style.setProperty('--seek-progress', pct);
}

function updateAudioUI(currentTime = 0, duration = 0) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeCurrent = Math.min(Math.max(currentTime, 0), safeDuration || Math.max(currentTime, 0));
  const progress = safeDuration > 0 ? (safeCurrent / safeDuration) * 100 : 0;
  seekEl.value = progress;
  updateSeekBackground(progress);
  currentTimeEl.textContent = fmtTime(safeCurrent);
  durationEl.textContent = fmtTime(safeDuration);
  timeEl.textContent = `${fmtTime(safeCurrent)} / ${fmtTime(safeDuration)}`;
}

function resetAudioUI() {
  playEl.textContent = '▶';
  updateAudioUI(0, 0);
}

async function getAudioDuration(blob) {
  return new Promise((resolve) => {
    const tmp = new Audio();
    const url = URL.createObjectURL(blob);
    let settled = false;

    const done = (dur) => {
      if (settled) return;
      settled = true;
      tmp.src = '';
      tmp.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(dur) && dur > 0 ? dur : 0);
    };

    // Webm-Dateien haben oft keinen Duration-Header beim Live-Recording.
    // Trick: currentTime auf einen sehr großen Wert setzen zwingt den Browser,
    // die Datei zu scannen und die echte Länge zu ermitteln.
    tmp.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(tmp.duration) && tmp.duration > 0 && tmp.duration < Infinity) {
        done(tmp.duration);
      } else {
        tmp.currentTime = 1e101; // seek ans Ende
      }
    });

    tmp.addEventListener('timeupdate', function handler() {
      if (Number.isFinite(tmp.duration) && tmp.duration > 0 && tmp.duration < Infinity) {
        tmp.removeEventListener('timeupdate', handler);
        done(tmp.duration);
      }
    });

    tmp.addEventListener('durationchange', () => {
      if (Number.isFinite(tmp.duration) && tmp.duration > 0 && tmp.duration < Infinity) {
        done(tmp.duration);
      }
    });

    tmp.addEventListener('error', () => done(0));
    setTimeout(() => done(0), 15000);

    tmp.preload = 'metadata';
    tmp.src = url;
  });
}

audioEl.addEventListener('timeupdate', () => {
  updateAudioUI(audioEl.currentTime, getEffectiveAudioDuration());
});
audioEl.addEventListener('loadedmetadata', () => {
  updateAudioUI(0, getEffectiveAudioDuration());
});
audioEl.addEventListener('durationchange', () => {
  updateAudioUI(audioEl.currentTime, getEffectiveAudioDuration());
});
audioEl.addEventListener('play', () => { playEl.textContent = '⏸'; });
audioEl.addEventListener('pause', () => { if (!audioEl.ended) playEl.textContent = '▶'; });
audioEl.addEventListener('ended', () => {
  playEl.textContent = '▶';
  updateAudioUI(getEffectiveAudioDuration(), getEffectiveAudioDuration());
});

playEl.addEventListener('click', async () => {
  if (audioEl.paused) {
    try {
      await audioEl.play();
    } catch {
      showBanner('Audio konnte nicht abgespielt werden.', 'error');
    }
  } else {
    audioEl.pause();
  }
});
seekEl.addEventListener('input', () => {
  const duration = getEffectiveAudioDuration();
  const nextTime = (Number(seekEl.value) / 100) * duration;
  if (duration > 0) {
    audioEl.currentTime = nextTime;
    updateAudioUI(nextTime, duration);
  }
});

document.getElementById('btn-delete-audio').addEventListener('click', () => {
  const s = getActive();
  if (!s) return;
  showConfirm(
    'Audiodatei löschen?',
    'Die Audiodatei wird dauerhaft gelöscht. Transkript und Notizen bleiben erhalten.',
    async () => {
      const dir = await getSessionDir(s);
      await deleteFile(dir, 'audio.webm');
      s.hasAudio = false;
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
      audioDurationFallback = 0;
      resetAudioUI();
      document.getElementById('audio-section').classList.add('hidden');
      await saveIndex();
      showBanner('🗑 Audiodatei gelöscht', 'info');
    }
  );
});

// ── Notizen Auto-Save ─────────────────────────────────────────────────────────
let notesSaveTimer = null;

document.getElementById('notes-textarea').addEventListener('input', e => {
  const s = getActive();
  if (!s) return;
  const ind = document.getElementById('notes-save-indicator');
  ind.textContent = 'Speichert…';
  ind.className   = 'saving';
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(async () => {
    try {
      s.notes = e.target.value;
      const dir = await getSessionDir(s);
      await writeFile(dir, 'notes.txt', s.notes);
      ind.textContent = 'Gespeichert ✓';
      ind.className   = 'saved';
      setTimeout(() => { ind.textContent = ''; ind.className = ''; }, 2000);
    } catch {
      ind.textContent = 'Fehler';
      ind.className   = '';
    }
  }, 500);
});

// ── Titel bearbeiten ──────────────────────────────────────────────────────────
document.getElementById('session-title-input').addEventListener('change', async e => {
  const s = getActive();
  if (!s) return;
  s.title = e.target.value.trim() || 'Unbenannte Aufnahme';
  renderSidebar();
  await saveIndex();
});

// ── Kopieren / Exportieren ─────────────────────────────────────────────────────
function copyActiveText(kind) {
  const s = getActive();
  if (!s) return;

  const content = kind === 'notes' ? (s.notes || '') : (s.transcript || '');
  if (!content.trim()) return;

  const label = kind === 'notes' ? 'Notizen' : 'Transkript';
  navigator.clipboard.writeText(content)
    .then(() => showBanner(`✓ ${label} kopiert`, 'success'));
}

document.getElementById('btn-copy-transcript').addEventListener('click', () => {
  copyActiveText('transcript');
});

document.getElementById('btn-copy-notes').addEventListener('click', () => {
  copyActiveText('notes');
});

document.getElementById('btn-export-transcript').addEventListener('click', e => {
  e.stopPropagation();
  showExportMenu(e.currentTarget, 'transcript');
});

document.getElementById('btn-export-notes').addEventListener('click', e => {
  e.stopPropagation();
  showExportMenu(e.currentTarget, 'notes');
});

const notesColEl = document.getElementById('notes-col');
const notesResizerEl = document.getElementById('notes-resizer');

function getSplitLayoutMetrics() {
  const appEl = document.getElementById('app');
  const appWidth = appEl.clientWidth;
  const resizerWidth = notesResizerEl.offsetWidth || 12;
  const transcriptMin = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--transcript-min-w'), 10) || 520;
  const notesMin = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--notes-min-w'), 10) || 320;
  const maxNotesWidth = Math.max(notesMin, appWidth - transcriptMin - resizerWidth);
  return { appWidth, resizerWidth, transcriptMin, notesMin, maxNotesWidth };
}

function clampNotesPaneWidth(width) {
  const { notesMin, maxNotesWidth } = getSplitLayoutMetrics();
  if (maxNotesWidth <= notesMin) return Math.max(240, maxNotesWidth);
  return Math.min(Math.max(width, notesMin), maxNotesWidth);
}

function setNotesPaneWidth(width, { persist = true } = {}) {
  const clampedWidth = clampNotesPaneWidth(width);
  S.notesPaneWidth = clampedWidth;
  notesColEl.style.width = `${clampedWidth}px`;
  notesColEl.style.flexBasis = `${clampedWidth}px`;
  if (persist) localStorage.setItem('privatescribe-notes-width', String(Math.round(clampedWidth)));
}

function applyNotesPaneWidth() {
  const defaultWidth = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--notes-w'), 10) || 360;
  setNotesPaneWidth(S.notesPaneWidth || defaultWidth, { persist: false });
}

let resizeState = null;

function stopNotesResize() {
  if (!resizeState) return;
  window.removeEventListener('pointermove', onNotesResizeMove);
  window.removeEventListener('pointerup', stopNotesResize);
  document.body.classList.remove('is-resizing');
  document.body.style.cursor = '';
  resizeState = null;
}

function onNotesResizeMove(event) {
  if (!resizeState) return;
  const delta = resizeState.startX - event.clientX;
  setNotesPaneWidth(resizeState.startWidth + delta);
}

function startNotesResize(event) {
  if (event.button !== 0) return;
  const active = getActive();
  if (!active) return;
  event.preventDefault();
  resizeState = { startX: event.clientX, startWidth: notesColEl.getBoundingClientRect().width };
  document.body.classList.add('is-resizing');
  document.body.style.cursor = 'col-resize';
  window.addEventListener('pointermove', onNotesResizeMove);
  window.addEventListener('pointerup', stopNotesResize);
}

notesResizerEl.addEventListener('pointerdown', startNotesResize);
notesResizerEl.addEventListener('dblclick', () => {
  const defaultWidth = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--notes-w'), 10) || 360;
  setNotesPaneWidth(defaultWidth);
});
notesResizerEl.addEventListener('keydown', event => {
  if (!getActive()) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
  event.preventDefault();
  const current = notesColEl.getBoundingClientRect().width;
  if (event.key === 'Home') {
    const defaultWidth = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--notes-w'), 10) || 360;
    setNotesPaneWidth(defaultWidth);
    return;
  }
  const delta = event.key === 'ArrowLeft' ? -24 : 24;
  setNotesPaneWidth(current + delta);
});
window.addEventListener('resize', () => {
  if (!getActive()) return;
  applyNotesPaneWidth();
});

// ── Retry ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-retry').addEventListener('click', async () => {
  const s = getActive();
  if (!s) return;
  const dir  = await getSessionDir(s);
  const blob = await readFileAsBlob(dir, 'audio.webm');
  if (!blob) { showBanner('Audiodatei nicht gefunden – kann nicht neu transkribieren.', 'error'); return; }
  runTranscription(s, blob);
});

// ── Neue Aufnahme – Modal ──────────────────────────────────────────────────────
const modalOverlay = document.getElementById('record-modal-overlay');
const btnRecord    = document.getElementById('btn-record');
const recTimerEl   = document.getElementById('record-timer');
const recLabelEl   = document.getElementById('record-label');
const recPhase     = document.getElementById('record-phase');
const titlePhase   = document.getElementById('title-phase');
const titleInput   = document.getElementById('title-input');
const btnSaveRec   = document.getElementById('btn-save-recording');

let mediaRecorder    = null;
let audioChunks      = [];
let recStartTime     = null;
let recTimerInterval = null;
let pendingAudioBlob = null;
let shouldSaveRecording = false;
let meterAudioCtx = null;
let meterAnalyser = null;
let meterSource = null;
let meterRAF = null;

const meterFillEl = document.getElementById('record-level-fill');

const RECORDING_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];
const RECORDING_AUDIO_BITS_PER_SECOND = 24000;

async function getMicrophoneStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

async function getSystemAudioStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Dieser Browser unterstützt keine Aufnahme von Fenster-, Bildschirm- oder System-Audio.');
  }

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
    },
    preferCurrentTab: false,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
    systemAudio: 'include',
    windowAudio: 'system',
  });

  const audioTracks = displayStream.getAudioTracks();
  if (audioTracks.length === 0) {
    displayStream.getTracks().forEach(track => track.stop());
    throw new Error('Kein Audio erkannt. Bitte beim Teilen „Audio teilen“ oder „Systemaudio teilen“ aktivieren und für Apps das richtige Fenster bzw. den Bildschirm auswählen.');
  }

  const audioStream = new MediaStream(audioTracks);
  audioStream._cleanup = () => displayStream.getTracks().forEach(track => track.stop());
  displayStream.getVideoTracks().forEach(track => {
    track.addEventListener('ended', () => {
      audioStream.getTracks().forEach(audioTrack => audioTrack.stop());
      if (S.recording) stopRecording();
    }, { once: true });
  });

  return audioStream;
}

document.getElementById('btn-new-recording').addEventListener('click', openRecordModal);
document.querySelectorAll('.record-source-option').forEach(btn => {
  btn.addEventListener('click', () => setRecordingSource(btn.dataset.source || 'microphone'));
});

function syncRecordingSourceControls() {
  document.querySelectorAll('.record-source-option').forEach(btn => {
    btn.disabled = S.recording;
  });
}

function setRecordingSource(source) {
  if (S.recording) return;

  S.recordingSource = source === 'system' ? 'system' : 'microphone';

  document.querySelectorAll('.record-source-option').forEach(btn => {
    const selected = btn.dataset.source === S.recordingSource;
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-pressed', String(selected));
  });

  const hintEl = document.getElementById('record-source-hint');
  if (hintEl) {
    hintEl.textContent = S.recordingSource === 'system'
      ? 'Browser fragt nach einem Tab, Fenster oder Bildschirm. Für YouTube-/Zoom-Apps wähle das jeweilige Fenster oder den ganzen Bildschirm und aktiviere dort „Audio teilen“ bzw. „Systemaudio teilen“.'
      : 'Mikrofonaufnahme mit Pegelanzeige.';
  }
}

function openRecordModal() {
  pendingAudioBlob = null;
  shouldSaveRecording = false;
  recPhase.style.display   = '';
  titlePhase.classList.remove('visible');
  btnRecord.classList.remove('pulsing');
  recTimerEl.textContent   = '00:00:00';
  recLabelEl.textContent   = 'Bereit zum Aufnehmen';
  recLabelEl.className     = '';
  updateRecordingLevel(0);
  document.querySelector('.record-modal .modal-sub').textContent = 'Wähle Mikrofon oder System-Audio und starte dann die Aufnahme';
  titleInput.value         = '';
  setRecordingSource(S.recordingSource);
  syncRecordingSourceControls();
  modalOverlay.classList.remove('hidden');
}

function closeRecordModal() {
  modalOverlay.classList.add('hidden');
  shouldSaveRecording = false;
  stopRecordingLevelMeter();
  stopMediaRecorderSilent();
}

document.getElementById('btn-cancel-record').addEventListener('click',  closeRecordModal);
document.getElementById('btn-cancel-title').addEventListener('click',  closeRecordModal);

btnRecord.addEventListener('click', () => {
  if (!S.recording) startRecording();
  else              stopRecording();
});

async function startRecording() {
  let stream;
  try {
    stream = S.recordingSource === 'system'
      ? await getSystemAudioStream()
      : await getMicrophoneStream();
  } catch (e) {
    const isSystem = S.recordingSource === 'system';
    recLabelEl.textContent = isSystem
      ? '⚠️ System-Audio konnte nicht gestartet werden'
      : '⚠️ Mikrofon-Zugriff verweigert';
    recLabelEl.className   = 'warning';
    if (e?.message) showBanner(e.message, 'warning');
    return;
  }

  if (S.recordingSource === 'microphone') startRecordingLevelMeter(stream);
  else updateRecordingLevel(0.18);

  audioChunks  = [];
  recStartTime = Date.now();
  shouldSaveRecording = false;
  S.recording  = true;
  syncRecordingSourceControls();

  const mime = RECORDING_MIME_CANDIDATES.find(type => MediaRecorder.isTypeSupported(type));
  const recorderOptions = {
    audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
  };
  if (mime) recorderOptions.mimeType = mime;
  mediaRecorder = new MediaRecorder(stream, recorderOptions);

  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    stream._cleanup?.();
    if (!shouldSaveRecording) return; // abgebrochen
    pendingAudioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    showTitleInput();
  };
  mediaRecorder.start(1000);

  btnRecord.classList.add('pulsing');
  btnRecord.textContent          = '⏹';
  recLabelEl.textContent         = '● Aufnahme läuft…';
  recLabelEl.className           = 'recording';
  document.querySelector('.record-modal .modal-sub').textContent = S.recordingSource === 'system'
    ? 'Teile ein Tab, Fenster oder den ganzen Bildschirm mit Audio und stoppe hier, wenn du fertig bist'
    : 'Drücke erneut zum Stoppen';

  recTimerInterval = setInterval(() => {
    const ms = Date.now() - recStartTime;
    recTimerEl.textContent = fmtDuration(ms);

    const WARN  = (3 * 60 + 45) * 60 * 1000;
    const MAX   = 4 * 60 * 60 * 1000;
    if (ms >= WARN && ms < WARN + 2000) {
      recLabelEl.textContent = '⚠️ Noch 15 Minuten Aufnahmezeit';
      recLabelEl.className   = 'warning';
      showBanner('⚠️ Noch 15 Minuten Aufnahmezeit', 'warning');
    }
    if (ms >= MAX) stopRecording();
  }, 250);
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  shouldSaveRecording = true;
  clearInterval(recTimerInterval);
  btnRecord.classList.remove('pulsing');
  btnRecord.textContent          = '⏺';
  recLabelEl.textContent         = 'Verarbeite…';
  recLabelEl.className           = '';
  mediaRecorder.stop();
  stopRecordingLevelMeter();
  S.recording = false;
  syncRecordingSourceControls();
}

function stopMediaRecorderSilent() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    shouldSaveRecording = false;
    S.recording = false;
    clearInterval(recTimerInterval);
    mediaRecorder.onstop = () => { mediaRecorder.stream?._cleanup?.(); };
    mediaRecorder.stop();
  }
  stopRecordingLevelMeter();
  S.recording = false;
  syncRecordingSourceControls();
}

function updateRecordingLevel(level) {
  if (!meterFillEl) return;
  const eased = Math.min(1, Math.max(0, level));
  meterFillEl.style.transform = `scaleX(${Math.max(0.06, eased)})`;
  meterFillEl.style.opacity = `${0.35 + (eased * 0.6)}`;
}

function startRecordingLevelMeter(stream) {
  stopRecordingLevelMeter();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;

  meterAudioCtx = new AudioCtx();
  meterAnalyser = meterAudioCtx.createAnalyser();
  meterAnalyser.fftSize = 256;
  meterAnalyser.smoothingTimeConstant = 0.88;
  meterSource = meterAudioCtx.createMediaStreamSource(stream);
  meterSource.connect(meterAnalyser);

  const data = new Uint8Array(meterAnalyser.fftSize);
  const tick = () => {
    if (!meterAnalyser) return;
    meterAnalyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / data.length);
    updateRecordingLevel(Math.min(1, rms * 3.2));
    meterRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopRecordingLevelMeter() {
  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = null;
  if (meterSource) meterSource.disconnect();
  if (meterAnalyser) meterAnalyser.disconnect();
  if (meterAudioCtx) meterAudioCtx.close().catch(() => {});
  meterSource = null;
  meterAnalyser = null;
  meterAudioCtx = null;
  updateRecordingLevel(0);
}

function showTitleInput() {
  recPhase.style.display = 'none';
  titlePhase.classList.add('visible');
  const now = new Date();
  const prefix = S.recordingSource === 'system' ? 'App-/System-Audio' : 'Aufnahme';
  titleInput.value = `${prefix} ${now.toLocaleDateString('de-DE')} ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  titleInput.focus();
  titleInput.select();
}

btnSaveRec.addEventListener('click', saveRecording);
titleInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); saveRecording(); }
  if (e.key === 'Escape') closeRecordModal();
});

async function saveRecording() {
  if (!pendingAudioBlob) return;
  const title = titleInput.value.trim() || 'Unbenannte Aufnahme';
  const blob  = pendingAudioBlob;
  pendingAudioBlob = null;
  closeRecordModal();
  await createSession(title, blob);
}

// ── Session erstellen ─────────────────────────────────────────────────────────
async function createSession(title, audioBlob) {
  const id        = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const session = {
    id,
    title,
    createdAt,
    dirName:          sessionDirName({ title, createdAt }),
    transcriptStatus: 'idle',
    hasAudio:         true,
    transcript:       '',
    notes:            '',
    downloadProgress: null,
  };

  const dir = await getOrCreateDir(S.rootDir, session.dirName);
  await writeFile(dir, 'audio.webm', audioBlob);
  await writeFile(dir, 'transcript.txt', '');
  await writeFile(dir, 'notes.txt', '');
  await writeFile(dir, 'meta.json', JSON.stringify({
    id, title, createdAt, transcriptStatus: 'idle'
  }, null, 2));

  S.sessions.unshift(session);
  await saveIndex();

  S.activeId = id;
  renderSidebar();
  renderMainArea();

  // Transkription sofort starten
  runTranscription(session, audioBlob);
}

// ── Transkription ausführen ───────────────────────────────────────────────────
async function runTranscription(session, audioBlob) {
  session.transcriptStatus = 'decoding';
  updateLiveStatus(session);

  try {
    const text = await transcribeAudio(audioBlob, S.modelSize, S.rootDir, (status, extra) => {
      session.transcriptStatus = status;
      if (status === 'loading' && extra) {
        session.downloadProgress = {
          file:     extra.file || '',
          progress: extra.progress ?? 0,
        };
      } else if (status !== 'loading') {
        session.downloadProgress = null;
      }
      updateLiveStatus(session);
    });

    session.transcript       = text;
    session.transcriptStatus = 'done';
    session.downloadProgress = null;

    const dir = await getSessionDir(session);
    await writeFile(dir, 'transcript.txt', text);
    await writeFile(dir, 'meta.json', JSON.stringify({
      id: session.id, title: session.title,
      createdAt: session.createdAt, transcriptStatus: 'done'
    }, null, 2));

    await saveIndex();
    updateLiveStatus(session);

    if (session.id === S.activeId) renderMainArea();
    showBanner('✓ Transkription abgeschlossen', 'success');

  } catch (err) {
    console.error('Transkriptionsfehler:', err);
    session.transcriptStatus = 'error';
    session.downloadProgress = null;
    await saveIndex();
    updateLiveStatus(session);
    if (session.id === S.activeId) renderMainArea();
    showBanner('Transkriptionsfehler: ' + err.message, 'error');
  }
}

/** Status-Badge + Sidebar live aktualisieren ohne vollständiges Neu-Rendern */
function updateLiveStatus(session) {
  // Sidebar-Badge
  const item = document.querySelector(`.session-item[data-id="${session.id}"]`);
  if (item) {
    const existing = item.querySelector('.sess-badge');
    const st = session.transcriptStatus;
    if (['decoding','loading','transcribing'].includes(st)) {
      if (!existing || !existing.classList.contains('transcribing')) {
        if (existing) existing.remove();
        const badge = document.createElement('span');
        badge.className = 'sess-badge transcribing';
        badge.textContent = '•••';
        item.querySelector('.sess-info').after(badge);
      }
    } else if (st === 'error') {
      if (!existing || !existing.classList.contains('error')) {
        if (existing) existing.remove();
        const badge = document.createElement('span');
        badge.className = 'sess-badge error';
        badge.textContent = '!';
        item.querySelector('.sess-info').after(badge);
      }
    } else {
      if (existing) existing.remove();
    }
  }

  // Haupt-Bereich (nur wenn aktiv)
  if (session.id === S.activeId) {
    renderStatusBadge(session);
    renderDownloadProgress(session);
  }
}

// ── Modell-Selector ───────────────────────────────────────────────────────────
function updateModelSelector() {
  const label = document.getElementById('model-label');
  if (label) {
    label.textContent = S.modelSize === 'medium' ? 'Whisper Medium' : 'Whisper Small';
  }
}

document.getElementById('btn-model-selector').addEventListener('click', e => {
  e.stopPropagation();
  const menu = document.getElementById('model-dropdown');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }

  // Positionnierung
  const rect = e.currentTarget.getBoundingClientRect();
  menu.style.left   = rect.left + 'px';
  menu.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  menu.style.top    = 'auto';

  menu.querySelectorAll('.model-drop-item').forEach(item => {
    item.classList.toggle('active', item.dataset.model === S.modelSize);
    item.querySelector('.mdi-check').style.visibility =
      item.dataset.model === S.modelSize ? 'visible' : 'hidden';
  });
  menu.classList.remove('hidden');
});

document.getElementById('model-dropdown').querySelectorAll('.model-drop-item').forEach(item => {
  item.addEventListener('click', () => {
    S.modelSize = item.dataset.model;
    localStorage.setItem('privatescribe-model', S.modelSize);
    updateModelSelector();
    updateWelcomeModelChoice();
    document.getElementById('model-dropdown').classList.add('hidden');
    showBanner(`Modell gewechselt: Whisper ${S.modelSize === 'medium' ? 'Medium' : 'Small'}`, 'info');
  });
});

document.addEventListener('click', () => {
  document.getElementById('model-dropdown').classList.add('hidden');
  document.getElementById('context-menu').classList.add('hidden');
  document.getElementById('export-menu').classList.add('hidden');
});

// ── Kontext-Menü ──────────────────────────────────────────────────────────────
function buildMenuButtons(menu, items) {
  menu.replaceChildren();

  items.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ctx-item${item.danger ? ' danger' : ''}`;

    Object.entries(item.dataset || {}).forEach(([key, value]) => {
      button.dataset[key] = value;
    });

    button.textContent = item.label;
    button.addEventListener('click', item.onClick);
    menu.appendChild(button);
  });
}

function showContextMenu(x, y, sessionId) {
  const menu = document.getElementById('context-menu');
  buildMenuButtons(menu, [
    {
      label: '✏️ Umbenennen',
      dataset: { action: 'rename' },
      onClick: () => {
        menu.classList.add('hidden');
        startRename(sessionId);
      },
    },
    {
      label: '🗑 Löschen',
      dataset: { action: 'delete' },
      danger: true,
      onClick: () => {
        menu.classList.add('hidden');
        confirmDeleteSession(sessionId);
      },
    },
  ]);

  const mx = Math.min(x, window.innerWidth  - 180);
  const my = Math.min(y, window.innerHeight - 90);
  menu.style.left = mx + 'px';
  menu.style.top  = my + 'px';
  menu.classList.remove('hidden');
}

function showExportMenu(anchorEl, kind) {
  const s = getActive();
  if (!s) return;

  const menu = document.getElementById('export-menu');
  const label = kind === 'transcript' ? 'Transkript' : 'Notizen';
  const formats = ['txt', 'md', 'json'];

  buildMenuButtons(menu, formats.map(format => ({
    label: `${label} als .${format}`,
    dataset: { format },
    onClick: () => {
      menu.classList.add('hidden');
      exportSessionField(s, kind, format);
    },
  })));

  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = Math.min(rect.left, window.innerWidth - 210) + 'px';
  menu.style.top = Math.min(rect.bottom + 8, window.innerHeight - 130) + 'px';
  menu.classList.remove('hidden');
}

function exportSessionField(session, kind, format) {
  const base = session.title || 'aufnahme';
  const slug = base.replace(/[^a-z0-9äöüß_-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'aufnahme';
  const content = kind === 'transcript' ? (session.transcript || '') : (session.notes || '');
  const suffix = kind === 'transcript' ? 'transkript' : 'notizen';

  if (!content.trim()) {
    showBanner(`${kind === 'transcript' ? 'Transkript' : 'Notizen'} sind leer.`, 'warning');
    return;
  }

  let payload = content;
  let mime = 'text/plain;charset=utf-8';
  if (format === 'md') {
    const title = kind === 'transcript' ? '# Transkript' : '# Notizen';
    payload = `${title}\n\n${content.trim()}\n`;
    mime = 'text/markdown;charset=utf-8';
  } else if (format === 'json') {
    payload = JSON.stringify({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      type: kind,
      content,
    }, null, 2);
    mime = 'application/json;charset=utf-8';
  }

  downloadTextFile(`${slug}_${suffix}.${format}`, payload, mime);
  showBanner(`✓ ${kind === 'transcript' ? 'Transkript' : 'Notizen'} exportiert`, 'success');
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function startRename(id) {
  const s    = findById(id);
  const item = document.querySelector(`.session-item[data-id="${id}"]`);
  if (!s || !item) return;

  const titleDiv = item.querySelector('.sess-title');
  const inp      = document.createElement('input');
  inp.className  = 'rename-input';
  inp.value      = s.title;
  titleDiv.replaceWith(inp);
  inp.focus(); inp.select();

  const finish = async () => {
    const newTitle = inp.value.trim() || s.title;
    s.title = newTitle;
    if (S.activeId === id) {
      document.getElementById('session-title-input').value = newTitle;
    }
    await saveIndex();
    renderSidebar();
  };
  inp.addEventListener('blur', finish);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    if (e.key === 'Escape') { inp.value = s.title; inp.blur(); }
  });
}

function confirmDeleteSession(id) {
  const s = findById(id);
  if (!s) return;
  showConfirm(
    `"${s.title}" löschen?`,
    'Alle Dateien dieser Sitzung (Audio, Transkript, Notizen) werden dauerhaft gelöscht.',
    async () => {
      try { await deleteDir(S.rootDir, s.dirName); } catch {}
      S.sessions = S.sessions.filter(x => x.id !== id);
      if (S.activeId === id) S.activeId = null;
      await saveIndex();
      renderSidebar();
      renderMainArea();
    }
  );
}

// ── Confirm Dialog ────────────────────────────────────────────────────────────
let confirmCb = null;

function showConfirm(title, text, cb, btnLabel = 'Löschen', isDanger = true) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-text').textContent  = text;
  const okBtn = document.getElementById('btn-confirm-ok');
  okBtn.textContent = btnLabel;
  okBtn.className   = 'cbtn ' + (isDanger ? 'danger' : 'primary');
  confirmCb = cb;
  document.getElementById('confirm-overlay').classList.remove('hidden');
}

document.getElementById('btn-confirm-cancel').addEventListener('click', () => {
  document.getElementById('confirm-overlay').classList.add('hidden');
  confirmCb = null;
});
document.getElementById('btn-confirm-ok').addEventListener('click', async () => {
  document.getElementById('confirm-overlay').classList.add('hidden');
  if (confirmCb) { await confirmCb(); confirmCb = null; }
});

// ── Banner ────────────────────────────────────────────────────────────────────
function showBanner(msg, type = 'info', autoHide = true) {
  const area = document.getElementById('banner-area');
  const div  = document.createElement('div');
  div.className = `banner ${type}`;
  div.innerHTML = `<span>${msg}</span><span class="banner-close">✕</span>`;
  div.querySelector('.banner-close').onclick = () => div.remove();
  area.appendChild(div);
  if (autoHide) setTimeout(() => div.remove(), 4000);
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot().catch(err => {
  console.error('Boot-Fehler:', err);
  showBanner('Interner Fehler: ' + err.message, 'error', false);
});
