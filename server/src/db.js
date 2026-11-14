import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { dataPath } from './config.js';

export const db = new Database(dataPath('kinoko.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  avatar TEXT NOT NULL DEFAULT 'violet',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS user_invites (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('movies','shows')),
  paths TEXT NOT NULL DEFAULT '[]',
  shared INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- A title is one movie or one show, regardless of how many servers or files
-- carry it. Files (local or from a linked server) hang off it as versions.
CREATE TABLE IF NOT EXISTS titles (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
  title TEXT NOT NULL,
  year INTEGER,
  norm_key TEXT NOT NULL,
  imdb_id TEXT,
  tmdb_id INTEGER,
  overview TEXT NOT NULL DEFAULT '',
  tagline TEXT NOT NULL DEFAULT '',
  genres TEXT NOT NULL DEFAULT '[]',
  cast_json TEXT NOT NULL DEFAULT '[]',
  directors TEXT NOT NULL DEFAULT '[]',
  rating REAL,
  runtime INTEGER,
  poster TEXT,
  backdrop TEXT,
  trailer TEXT,
  tmdb_collection TEXT,
  series_json TEXT NOT NULL DEFAULT '[]',
  meta_source TEXT,
  meta_at INTEGER,
  added_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS titles_imdb ON titles(kind, imdb_id) WHERE imdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS titles_norm ON titles(kind, norm_key);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  overview TEXT NOT NULL DEFAULT '',
  still TEXT,
  air_date TEXT,
  UNIQUE (title_id, season, episode)
);

CREATE TABLE IF NOT EXISTS peers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  out_key TEXT,            -- key we present when calling them (null: they don't share with us)
  in_key_hash TEXT,        -- sha256 of the key they present to us (null: we don't share with them)
  last_sync INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_invites (
  token TEXT PRIMARY KEY,
  mutual INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  peer_id INTEGER REFERENCES peers(id) ON DELETE CASCADE,   -- null = this server
  remote_id INTEGER,                                        -- file id on the peer
  library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  bitrate INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  vcodec TEXT NOT NULL DEFAULT '',
  acodec TEXT NOT NULL DEFAULT '',
  container TEXT NOT NULL DEFAULT '',
  hdr INTEGER NOT NULL DEFAULT 0,
  streams TEXT NOT NULL DEFAULT '{"audio":[],"subs":[]}',
  markers_done INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS files_local ON files(path) WHERE peer_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS files_remote ON files(peer_id, remote_id) WHERE peer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS files_title ON files(title_id);
CREATE INDEX IF NOT EXISTS files_episode ON files(episode_id);

CREATE TABLE IF NOT EXISTS markers (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('intro','credits')),
  start REAL NOT NULL,
  end REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (file_id, kind)
);

CREATE TABLE IF NOT EXISTS subtitles (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subtitles_file ON subtitles(file_id);

CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, title_id, episode_id)
);
CREATE TABLE IF NOT EXISTS mylist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, title_id)
);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  overview TEXT NOT NULL DEFAULT '',
  poster TEXT,
  backdrop TEXT
);
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, title_id)
);

CREATE TABLE IF NOT EXISTS iptv_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('xtream','m3u')),
  url TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  proxy INTEGER NOT NULL DEFAULT 0,
  last_sync INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS iptv_channels (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES iptv_sources(id) ON DELETE CASCADE,
  ext_id TEXT NOT NULL,
  name TEXT NOT NULL,
  logo TEXT,
  category TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, ext_id)
);
CREATE TABLE IF NOT EXISTS iptv_favs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES iptv_channels(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, channel_id)
);
`);

// ---- migrations -------------------------------------------------------------
// The schema above is the baseline (user_version 0). Every later change is a
// numbered step here: entry i brings the database to version i + 1. A step runs
// once, inside a transaction, and may only add — never drop data. Append only;
// never edit or reorder a step that has shipped.
export function addColumn(database, table, column, definition) {
  if (!database.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
export const MIGRATIONS = [];

export function migrate(database = db, steps = MIGRATIONS) {
  const from = database.pragma('user_version', { simple: true });
  for (let i = from; i < steps.length; i++) {
    database.transaction(() => { steps[i](database); database.pragma(`user_version = ${i + 1}`); })();
  }
  return database.pragma('user_version', { simple: true });
}
migrate();

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export const settings = {
  get(key, fallback = null) {
    const row = getStmt.get(key);
    return row ? JSON.parse(row.value) : fallback;
  },
  set(key, value) { setStmt.run(key, JSON.stringify(value)); },
};

export const now = () => Math.floor(Date.now() / 1000);
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// A stable per-install id; used so two linked servers can recognise each other.
if (!settings.get('server_id')) settings.set('server_id', randomToken(9));
if (!settings.get('server_name')) settings.set('server_name', 'Kinoko');

/** Small friendly error that routes turn into a JSON response. */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
