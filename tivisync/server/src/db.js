'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tivisync.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  pin_hash TEXT,                       -- NULL = no PIN
  is_child INTEGER NOT NULL DEFAULT 0,
  daily_limit_min INTEGER,             -- NULL = unlimited
  blocked_keywords TEXT NOT NULL DEFAULT '', -- comma list, hides matching categories
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('xtream','m3u')),
  url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  epg_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  now_profile_id INTEGER,
  now_title TEXT,
  now_at INTEGER
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_sessions (
  token TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,          -- e.g. "1:movie:12345" / "1:episode:999" / "1:live:42"
  type TEXT NOT NULL,              -- movie | episode | live
  source_id INTEGER,
  stream_id TEXT,
  series_id TEXT,
  season INTEGER,
  episode INTEGER,
  title TEXT,
  series_title TEXT,
  poster TEXT,
  url TEXT,
  position_ms INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  device_id INTEGER,
  PRIMARY KEY (profile_id, item_key)
);
CREATE INDEX IF NOT EXISTS progress_recent ON progress(profile_id, updated_at DESC);

-- age ratings for films / series (looked up on TMDB in the background, or set by hand in the panel)
CREATE TABLE IF NOT EXISTS title_ratings (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- movie | series
  ref TEXT NOT NULL,
  name TEXT,
  year INTEGER,
  tmdb_id INTEGER,
  cert TEXT,                       -- e.g. 12A, PG-13, TV-14
  country TEXT,
  age INTEGER,                     -- 0 (U) .. 18; NULL = unknown
  status TEXT NOT NULL DEFAULT 'pending', -- pending | rated | none | manual | error
  checked_at INTEGER,
  PRIMARY KEY (source_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS title_ratings_status ON title_ratings(status);

-- channels a profile should NOT see (per IPTV source). ref = Xtream stream_id, or the stream URL for M3U.
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL,
  channel_ref TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_logo TEXT,
  title TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (profile_id, source_id, channel_ref, start)
);

CREATE TABLE IF NOT EXISTS channel_hidden (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  PRIMARY KEY (profile_id, source_id, ref)
);

CREATE TABLE IF NOT EXISTS favorites (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, item_key)
);

CREATE TABLE IF NOT EXISTS usage_daily (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day TEXT NOT NULL,               -- YYYY-MM-DD in server TZ
  seconds INTEGER NOT NULL DEFAULT 0,
  bonus_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, day)
);

CREATE TABLE IF NOT EXISTS usage_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id INTEGER,
  type TEXT,
  title TEXT,
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_sessions_recent ON usage_sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS time_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id INTEGER,
  minutes INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
  granted_minutes INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
`);

// migrations for columns added after v1.0
for (const sql of [
  'ALTER TABLE sources ADD COLUMN required_ip TEXT',
  'ALTER TABLE sources ADD COLUMN updated_at INTEGER',
  'ALTER TABLE devices ADD COLUMN wg_config TEXT',
  'ALTER TABLE sources ADD COLUMN backup_urls TEXT',
  'ALTER TABLE profiles ADD COLUMN max_age INTEGER',
  'ALTER TABLE profiles ADD COLUMN watch_hours TEXT', // JSON: 7 entries Mon..Sun, each null (any time) | {from,to} | "off"
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
  // diagnostic log lines sent by the TV / phone apps (kept 7 days)
  'CREATE TABLE IF NOT EXISTS device_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL, ts INTEGER NOT NULL, level TEXT NOT NULL, tag TEXT NOT NULL, msg TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS device_logs_dev_ts ON device_logs (device_id, ts)',
  // public TMDB score per title (0 = none yet)
  'ALTER TABLE title_ratings ADD COLUMN score REAL',
  'ALTER TABLE title_ratings ADD COLUMN votes INTEGER',
  // "Want to watch" list per profile (same shape as favourites)
  'CREATE TABLE IF NOT EXISTS watchlist (profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, item_key TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (profile_id, item_key))',
  // episode count per series (reported by the TV) so a fully watched series can show a tick
  'CREATE TABLE IF NOT EXISTS series_totals (source_id INTEGER NOT NULL, series_id TEXT NOT NULL, total INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (source_id, series_id))',
  // when a series last gained episodes (for the "New episodes" row), and which app build each TV runs
  'ALTER TABLE series_totals ADD COLUMN grown_at INTEGER',
  'ALTER TABLE devices ADD COLUMN app_build TEXT',
]) {
  try { db.exec(sql); } catch { /* already exists */ }
}

module.exports = { db, DATA_DIR };
