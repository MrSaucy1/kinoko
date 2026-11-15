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
export const MIGRATIONS = [
  // 1 — fase 1: series preferences, subtitle offsets, extras, per-user quality limit, webhooks.
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS series_prefs (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        audio_lang TEXT NOT NULL DEFAULT '',
        sub_lang TEXT NOT NULL DEFAULT '',     -- '' = no preference, 'off' = subtitles off
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, title_id)
      );
      CREATE TABLE IF NOT EXISTS sub_offsets (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        offset_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, file_id)
      );
      CREATE TABLE IF NOT EXISTS extras (
        id INTEGER PRIMARY KEY,
        library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'extra',
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        vcodec TEXT NOT NULL DEFAULT '',
        acodec TEXT NOT NULL DEFAULT '',
        container TEXT NOT NULL DEFAULT '',
        added_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extras_title ON extras(title_id);
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'discord' CHECK (format IN ('discord','json')),
        events TEXT NOT NULL DEFAULT '[]',
        last_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    addColumn(d, 'users', 'max_quality', "TEXT NOT NULL DEFAULT ''");   // '' = no limit, else a key of QUALITIES
  },
  // 2 — fase 2: two-factor sign-in, audit log, per-user library access.
  (d) => {
    addColumn(d, 'users', 'totp_secret', 'TEXT');
    addColumn(d, 'users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(d, 'users', 'totp_last', 'INTEGER NOT NULL DEFAULT 0');        // last accepted time step (no code twice)
    addColumn(d, 'users', 'recovery_codes', "TEXT NOT NULL DEFAULT '[]'");   // sha256 hashes
    addColumn(d, 'users', 'all_libraries', 'INTEGER NOT NULL DEFAULT 1');    // 0 = only what library_access lists
    addColumn(d, 'users', 'allow_peers', 'INTEGER NOT NULL DEFAULT 1');      // content from linked servers
    d.exec(`
      CREATE TABLE IF NOT EXISTS library_access (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, library_id)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        user_id INTEGER,
        user_name TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
      CREATE INDEX IF NOT EXISTS audit_action ON audit_log(action, id);
    `);
  },
  // 3 — fase 3: age ratings, kids mode, trickplay.
  (d) => {
    addColumn(d, 'titles', 'age', 'INTEGER');                               // minimum age (0 = AL), null = unknown
    addColumn(d, 'titles', 'age_source', 'TEXT');
    addColumn(d, 'users', 'max_age', 'INTEGER');                            // null = no limit
    addColumn(d, 'users', 'hide_unrated', 'INTEGER NOT NULL DEFAULT 1');    // with a limit: hide titles without a rating
    addColumn(d, 'users', 'kids_home', 'INTEGER NOT NULL DEFAULT 0');       // simplified home
    addColumn(d, 'libraries', 'trickplay', 'INTEGER NOT NULL DEFAULT 0');   // seek previews for this library
    addColumn(d, 'files', 'trickplay', 'TEXT');                             // JSON once generated, 'none' when it failed
    d.exec('CREATE INDEX IF NOT EXISTS titles_age ON titles(age)');
  },
  // 4 — fase 4: shared lists, watch history per day (for Wrapped), Wrapped share links.
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS lists (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lists_owner ON lists(owner_id);
      CREATE TABLE IF NOT EXISTS list_items (
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        added_by INTEGER,
        added_at INTEGER NOT NULL,
        ord INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (list_id, title_id)
      );
      CREATE TABLE IF NOT EXISTS list_shares (
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        can_edit INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (list_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS list_shares_user ON list_shares(user_id);
      CREATE TABLE IF NOT EXISTS watch_log (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        episode_id INTEGER NOT NULL DEFAULT 0,
        day TEXT NOT NULL,                       -- YYYY-MM-DD, server time
        seconds REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, title_id, episode_id, day)
      );
      CREATE INDEX IF NOT EXISTS watch_log_user_day ON watch_log(user_id, day);
      CREATE TABLE IF NOT EXISTS wrapped_shares (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, year)
      );
    `);
    // What was watched before this version: one entry per title/episode on the day it was last touched.
    d.exec(`INSERT OR IGNORE INTO watch_log (user_id, title_id, episode_id, day, seconds)
      SELECT user_id, title_id, episode_id, date(updated_at, 'unixepoch', 'localtime'), CASE WHEN watched = 1 THEN duration ELSE position END
      FROM progress WHERE (CASE WHEN watched = 1 THEN duration ELSE position END) > 0`);
  },
  // 5 — fase 5: requests for films and series.
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
        title TEXT NOT NULL,
        year INTEGER,
        imdb_id TEXT,
        tmdb_id INTEGER,
        poster TEXT,
        overview TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','available')),
        note TEXT NOT NULL DEFAULT '',
        forwarded TEXT NOT NULL DEFAULT '',          -- '', 'radarr', 'sonarr' or an error text
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by INTEGER
      );
      CREATE INDEX IF NOT EXISTS requests_user ON requests(user_id);
      CREATE INDEX IF NOT EXISTS requests_status ON requests(status, id);
    `);
  },
  // 6 — fase 6: music. The libraries table gets a third type; its CHECK cannot be altered in
  // place, so the table is rebuilt with every row and id intact (see `fkOff` in migrate()).
  {
    fkOff: true,
    run: (d) => {
      d.exec(`
        CREATE TABLE libraries_new (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('movies','shows','music')),
          paths TEXT NOT NULL DEFAULT '[]',
          shared INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          trickplay INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO libraries_new (id, name, type, paths, shared, created_at, trickplay) SELECT id, name, type, paths, shared, created_at, trickplay FROM libraries;
        DROP TABLE libraries;
        ALTER TABLE libraries_new RENAME TO libraries;

        CREATE TABLE IF NOT EXISTS artists (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          norm TEXT NOT NULL UNIQUE,
          mbid TEXT,
          image TEXT,
          bio TEXT NOT NULL DEFAULT '',
          meta_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS albums (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          norm TEXT NOT NULL,
          artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
          year INTEGER,
          mbid TEXT,
          cover TEXT,
          meta_at INTEGER,
          added_at INTEGER NOT NULL,
          UNIQUE (artist_id, norm)
        );
        CREATE INDEX IF NOT EXISTS albums_added ON albums(added_at);
        CREATE INDEX IF NOT EXISTS albums_norm ON albums(norm);
        CREATE TABLE IF NOT EXISTS album_artists (
          album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
          artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
          PRIMARY KEY (album_id, artist_id)
        );
        CREATE INDEX IF NOT EXISTS album_artists_artist ON album_artists(artist_id);
        CREATE TABLE IF NOT EXISTS tracks (
          id INTEGER PRIMARY KEY,
          library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
          peer_id INTEGER REFERENCES peers(id) ON DELETE CASCADE,
          remote_id INTEGER,
          album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
          artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          norm TEXT NOT NULL,
          track_no INTEGER NOT NULL DEFAULT 0,
          disc_no INTEGER NOT NULL DEFAULT 1,
          duration REAL NOT NULL DEFAULT 0,
          path TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          mtime INTEGER NOT NULL DEFAULT 0,
          codec TEXT NOT NULL DEFAULT '',
          container TEXT NOT NULL DEFAULT '',
          bitrate INTEGER NOT NULL DEFAULT 0,
          sample_rate INTEGER NOT NULL DEFAULT 0,
          channels INTEGER NOT NULL DEFAULT 2,
          year INTEGER,
          explicit INTEGER NOT NULL DEFAULT 0,
          mb_track_id TEXT,
          rg_track_gain REAL, rg_track_peak REAL, rg_album_gain REAL, rg_album_peak REAL,
          has_cover INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS tracks_local ON tracks(path) WHERE peer_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS tracks_remote ON tracks(peer_id, remote_id) WHERE peer_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id, disc_no, track_no);
        CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist_id);
        CREATE INDEX IF NOT EXISTS tracks_norm ON tracks(norm);
        CREATE INDEX IF NOT EXISTS tracks_added ON tracks(added_at);
        CREATE INDEX IF NOT EXISTS tracks_library ON tracks(library_id);
        CREATE TABLE IF NOT EXISTS genres (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS track_genres (
          track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
          PRIMARY KEY (track_id, genre_id)
        );
        CREATE INDEX IF NOT EXISTS track_genres_genre ON track_genres(genre_id);
        CREATE TABLE IF NOT EXISTS playlists (
          id INTEGER PRIMARY KEY,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS playlists_owner ON playlists(owner_id);
        CREATE TABLE IF NOT EXISTS playlist_items (
          id INTEGER PRIMARY KEY,
          playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
          track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          ord INTEGER NOT NULL,
          added_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS playlist_items_list ON playlist_items(playlist_id, ord);
        CREATE TABLE IF NOT EXISTS playlist_shares (
          playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          can_edit INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (playlist_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS playlist_shares_user ON playlist_shares(user_id);
        CREATE TABLE IF NOT EXISTS music_likes (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          at INTEGER NOT NULL,
          PRIMARY KEY (user_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS music_likes_at ON music_likes(user_id, at);
        CREATE TABLE IF NOT EXISTS music_plays (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          at INTEGER NOT NULL,
          seconds REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS music_plays_user ON music_plays(user_id, at);
        CREATE INDEX IF NOT EXISTS music_plays_track ON music_plays(track_id);
        CREATE TABLE IF NOT EXISTS music_queue (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          items TEXT NOT NULL DEFAULT '[]',
          idx INTEGER NOT NULL DEFAULT 0,
          position REAL NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  // 7 — fase 8: lyrics cache, measured loudness, scrobbling accounts.
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS lyrics (
        track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        synced TEXT NOT NULL DEFAULT '',      -- LRC with timestamps
        plain TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',      -- lrc | tags | lrclib | none
        fetched_at INTEGER NOT NULL
      );
    `);
    addColumn(d, 'tracks', 'loudness_done', 'INTEGER NOT NULL DEFAULT 0');   // measured (or tried) by the background task
    addColumn(d, 'users', 'lb_token', 'TEXT');             // ListenBrainz user token
    addColumn(d, 'users', 'lastfm_session', 'TEXT');       // Last.fm session key
    addColumn(d, 'users', 'lastfm_name', 'TEXT');
  },
];

export function migrate(database = db, steps = MIGRATIONS) {
  const from = database.pragma('user_version', { simple: true });
  for (let i = from; i < steps.length; i++) {
    const step = steps[i], fn = typeof step === 'function' ? step : step.run;
    // A step that rebuilds a table other tables point at (`fkOff`) follows SQLite's own recipe:
    // foreign keys off around the transaction, and a check that every reference still holds before it commits.
    const fkOff = typeof step === 'object' && step.fkOff === true;
    if (fkOff) database.pragma('foreign_keys = OFF');
    try {
      database.transaction(() => {
        fn(database);
        if (fkOff && database.pragma('foreign_key_check').length) throw new Error(`migratie ${i + 1}: verwijzingen kloppen niet meer`);
        database.pragma(`user_version = ${i + 1}`);
      })();
    } finally { if (fkOff) database.pragma('foreign_keys = ON'); }
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
