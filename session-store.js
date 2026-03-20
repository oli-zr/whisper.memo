import {
  getOrCreateDir,
  writeFile,
  readFile,
  readFileAsBlob,
  deleteFile,
} from './storage.js';
import {
  INDEX_FILENAME,
  INDEX_TEMP_FILENAME,
  DEFAULT_AUDIO_FILENAME,
  parseIndexData,
  getAudioFilename,
  getSessionAudioFilename,
  sessionDirName,
} from './app-shared.js';

export function hydrateSession(session) {
  if (session.transcript === undefined) session.transcript = undefined;
  if (session.notes === undefined) session.notes = undefined;
  if (!session.downloadProgress) session.downloadProgress = null;
  if (session.hasAudio && !session.audioFilename) session.audioFilename = DEFAULT_AUDIO_FILENAME;
  return session;
}

export async function loadSessions(rootDir) {
  const raw = await readFile(rootDir, INDEX_FILENAME);
  const parsed = parseIndexData(raw);
  if (parsed !== null) {
    await deleteFile(rootDir, INDEX_TEMP_FILENAME);
    return parsed.map(hydrateSession);
  }

  const tempRaw = await readFile(rootDir, INDEX_TEMP_FILENAME);
  const recovered = parseIndexData(tempRaw);
  if (recovered !== null) {
    await writeFile(rootDir, INDEX_FILENAME, tempRaw);
    await deleteFile(rootDir, INDEX_TEMP_FILENAME);
    console.warn('index.json war ungültig und wurde aus index.json.tmp wiederhergestellt.');
    return recovered.map(hydrateSession);
  }

  return [];
}

export async function saveSessionsIndex(rootDir, sessions) {
  const data = sessions.map(({ id, title, createdAt, dirName, transcriptStatus, hasAudio, audioFilename }) => ({
    id,
    title,
    createdAt,
    dirName,
    transcriptStatus,
    hasAudio,
    audioFilename,
  }));
  const serialized = JSON.stringify(data, null, 2);
  await writeFile(rootDir, INDEX_TEMP_FILENAME, serialized);
  await writeFile(rootDir, INDEX_FILENAME, serialized);
  await deleteFile(rootDir, INDEX_TEMP_FILENAME);
}

export async function getSessionDir(rootDir, session) {
  return getOrCreateDir(rootDir, session.dirName);
}

export async function loadSessionContent(rootDir, session) {
  if (session.transcript !== undefined) return session;

  try {
    const dir = await getSessionDir(rootDir, session);
    session.transcript = await readFile(dir, 'transcript.txt') ?? '';
    session.notes = await readFile(dir, 'notes.txt') ?? '';
  } catch {
    session.transcript = '';
    session.notes = '';
  }

  return session;
}

export async function createSessionRecord(rootDir, title, audioBlob) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const audioFilename = getAudioFilename(audioBlob);

  const session = hydrateSession({
    id,
    title,
    createdAt,
    dirName: sessionDirName({ title, createdAt }),
    transcriptStatus: 'idle',
    hasAudio: true,
    audioFilename,
    transcript: '',
    notes: '',
    downloadProgress: null,
  });

  const dir = await getOrCreateDir(rootDir, session.dirName);
  await writeFile(dir, audioFilename, audioBlob);
  await writeFile(dir, 'transcript.txt', '');
  await writeFile(dir, 'notes.txt', '');
  await writeSessionMeta(rootDir, session);

  return session;
}

export async function writeSessionMeta(rootDir, session) {
  const dir = await getSessionDir(rootDir, session);
  await writeFile(dir, 'meta.json', JSON.stringify({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    transcriptStatus: session.transcriptStatus,
    audioFilename: session.audioFilename,
  }, null, 2));
}

export async function readSessionAudioBlob(rootDir, session) {
  const dir = await getSessionDir(rootDir, session);
  return readFileAsBlob(dir, getSessionAudioFilename(session));
}
