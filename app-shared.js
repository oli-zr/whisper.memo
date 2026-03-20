export const INDEX_FILENAME = 'index.json';
export const INDEX_TEMP_FILENAME = 'index.json.tmp';
export const DEFAULT_AUDIO_FILENAME = 'audio.webm';

export function isInProgressStatus(status) {
  return ['decoding', 'loading', 'transcribing'].includes(status);
}

export function parseIndexData(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

export function getSessionAudioFilename(session) {
  return session?.audioFilename || DEFAULT_AUDIO_FILENAME;
}

export function sanitizeExtension(extension) {
  const normalized = extension.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized ? `.${normalized}` : '.webm';
}

export function getExtensionFromMimeType(mimeType) {
  if (!mimeType) return '.webm';
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  const mimeToExt = {
    'audio/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/wave': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
  };
  return mimeToExt[normalized] || '.webm';
}

export function getAudioFilename(audioBlob) {
  if (audioBlob instanceof File) {
    const match = /\.[^.]+$/.exec(audioBlob.name);
    if (match) return `audio${sanitizeExtension(match[0])}`;
  }
  return `audio${getExtensionFromMimeType(audioBlob.type)}`;
}

export function sessionDirName(session) {
  const date = new Date(session.createdAt).toISOString().slice(0, 10);
  const slug = (session.title || 'Unbenannt')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 50);
  return `${date}_${slug}`;
}

export function slugifySessionTitle(title, fallback = 'aufnahme') {
  return (title || fallback)
    .replace(/[^a-z0-9äöüß_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

export function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
