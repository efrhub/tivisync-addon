'use strict';
// 🗓 TV guide (EPG) kept on the server: once a day the add-on downloads each source's full XMLTV guide
// (the source's own EPG address, or the Xtream provider's xmltv.php) and stores the channels the family can
// actually see in a separate SQLite file (epg.db – kept out of the settings backup). The TVs then read the
// guide from here instead of asking the provider channel by channel, and channel icons in the guide fill
// in logos the provider's channel list leaves out.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const DAY = 86400_000;
const AHEAD = 8 * DAY;            // as far ahead as the TV guide goes
const BACK_ARCHIVE = 8 * DAY;     // catch-up channels: keep a week back
const BACK_PLAIN = 12 * 3600_000; // other channels: just what's on now
const DESC_AHEAD = 3 * DAY;       // descriptions for the next 3 days (and the past, for catch-up)
const MAX_CHANNELS = Number(process.env.EPG_MAX_CHANNELS) || 4000; // distinct guide ids per source

let db = null;
function open(dataDir) {
  if (db) return db;
  db = new DatabaseSync(path.join(dataDir, 'epg.db'));
  db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS programmes (
  source_id INTEGER NOT NULL, ch TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL,
  title TEXT NOT NULL, descr TEXT, PRIMARY KEY (source_id, ch, start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS programmes_stop ON programmes(source_id, stop);
CREATE TABLE IF NOT EXISTS stage (
  source_id INTEGER NOT NULL, ch TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL,
  title TEXT NOT NULL, descr TEXT, PRIMARY KEY (source_id, ch, start)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS channels (
  source_id INTEGER NOT NULL, ch TEXT NOT NULL, name TEXT, icon TEXT, PRIMARY KEY (source_id, ch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS status (source_id INTEGER PRIMARY KEY, json TEXT NOT NULL);
`);
  return db;
}

// ------------------------------------------------------------------ XMLTV parsing (streamed, no dependencies)

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unxml(s) {
  if (s == null) return s;
  s = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENT[e.toLowerCase()] ?? m;
  }).trim();
}
const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag); return m ? unxml(m[2] ?? m[3]) : null; };
const inner = (xml, name) => { const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? unxml(m[1]) : null; };

/** "20261114210000 +0100" -> ms since epoch (no zone = UTC) */
function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}):?(\d{2})?/.exec(String(s || '').trim());
  if (!m) return null;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) { const sign = m[7][0] === '-' ? -1 : 1; t -= sign * (Math.abs(+m[7]) * 60 + Number(m[8] || 0)) * 60_000; }
  return t;
}

/** Calls onChannel({id,name,icon}) and onProgramme({ch,start,stop,title,desc}) for every element in an XMLTV stream. */
async function parseXmltv(stream, { onChannel, onProgramme }) {
  let buf = '';
  const decoder = new TextDecoder('utf-8');
  const drain = (final) => {
    let pos = 0, nextA = -2, nextB = -2; // cached search results: the buffer can hold thousands of elements
    for (;;) {
      if (nextA !== -1 && nextA < pos) nextA = buf.indexOf('<programme', pos);
      if (nextB !== -1 && nextB < pos) nextB = buf.indexOf('<channel', pos);
      const a = nextA, b = nextB;
      const at = a < 0 ? b : b < 0 ? a : Math.min(a, b);
      if (at < 0) { pos = Math.max(pos, buf.length - 12); break; }
      const isProg = at === a;
      const close = isProg ? '</programme>' : '</channel>';
      const tagEnd = buf.indexOf('>', at);
      if (tagEnd < 0) { pos = at; break; }
      if (buf[tagEnd - 1] === '/') { pos = tagEnd + 1; continue; } // <programme ... /> – nothing in it
      const end = buf.indexOf(close, tagEnd);
      if (end < 0) { pos = at; break; }
      const open = buf.slice(at, tagEnd + 1), body = buf.slice(tagEnd + 1, end);
      pos = end + close.length;
      if (isProg) {
        const start = xmltvTime(attr(open, 'start')), stop = xmltvTime(attr(open, 'stop')), ch = attr(open, 'channel');
        if (start != null && stop != null && ch) onProgramme({ ch: ch.toLowerCase(), start, stop, title: inner(body, 'title') || '', desc: inner(body, 'desc') });
      } else {
        const id = attr(open, 'id');
        if (id) { const icon = /<icon\b[^>]*>/i.exec(body); onChannel({ id: id.toLowerCase(), name: inner(body, 'display-name'), icon: icon ? attr(icon[0], 'src') : null }); }
      }
    }
    buf = final ? '' : buf.slice(pos);
  };
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (buf.length > 1024 * 1024) drain(false);
    if (buf.length > 64 * 1024 * 1024) throw new Error('guide file has an element over 64 MB – not XMLTV?');
  }
  buf += decoder.decode();
  drain(true);
}

/** Opens the guide (URL or local file), un-gzipping when needed. */
async function openGuide(where) {
  let src;
  if (where.file) src = fs.createReadStream(where.file);
  else {
    const r = await fetch(where.url, { headers: { 'User-Agent': 'TiviSync/1.0' }, signal: AbortSignal.timeout(15 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`guide download answered ${r.status}`);
    src = Readable.fromWeb(r.body);
  }
  // peek at the first two bytes for gzip
  const it = src[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) throw new Error('the guide file is empty');
  const head = Buffer.from(first.value);
  const rest = Readable.from((async function* () { yield head; for (;;) { const n = await it.next(); if (n.done) return; yield n.value; } })());
  return head[0] === 0x1f && head[1] === 0x8b ? rest.pipe(zlib.createGunzip()) : rest;
}

// ------------------------------------------------------------------ daily refresh

/**
 * where: { url } or { file }; wanted: Map(epgId lower -> { archive: bool }) or null for "everything".
 * Returns a status object (also saved for the panel).
 */
async function refreshSource(sourceId, where, wanted, log = console) {
  const d = db;
  if (!d) throw new Error('guide store not opened');
  const t0 = Date.now(), now = t0;
  const status = { sourceId, at: now, lastOkAt: lastOk(sourceId) || null, ok: false, channels: 0, programmes: 0, skipped: 0, icons: 0, ms: 0, error: null, wanted: wanted ? wanted.size : null };
  const ins = d.prepare('INSERT OR REPLACE INTO stage (source_id, ch, start, stop, title, descr) VALUES (?,?,?,?,?,?)');
  const chans = new Map();
  const seen = new Set();
  let minStart = Infinity, n = 0;
  d.prepare('DELETE FROM stage WHERE source_id = ?').run(sourceId);
  d.exec('BEGIN');
  try {
    const stream = await openGuide(where);
    await parseXmltv(stream, {
      onChannel: (c) => { if (!wanted || wanted.has(c.id)) chans.set(c.id, c); },
      onProgramme: (p) => {
        const w = wanted ? wanted.get(p.ch) : { archive: true };
        if (!w) { status.skipped++; return; }
        const back = w.archive ? BACK_ARCHIVE : BACK_PLAIN;
        if (p.stop < now - back || p.start > now + AHEAD || p.stop <= p.start) return;
        const desc = p.desc && (p.start < now + DESC_AHEAD) ? p.desc.slice(0, 1200) : null;
        ins.run(sourceId, p.ch, p.start, p.stop, p.title.slice(0, 200), desc);
        seen.add(p.ch);
        if (p.start < minStart) minStart = p.start;
        if (++n % 20000 === 0) { d.exec('COMMIT'); d.exec('BEGIN'); }
      },
    });
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    d.prepare('DELETE FROM stage WHERE source_id = ?').run(sourceId);
    status.error = e.message; status.ms = Date.now() - t0;
    saveStatus(sourceId, status);
    log.warn(`Guide (EPG) for source ${sourceId} failed: ${e.message}`);
    return status;
  }
  if (!n) {
    d.prepare('DELETE FROM stage WHERE source_id = ?').run(sourceId);
    status.error = wanted && wanted.size === 0 ? 'no channels to keep a guide for' : 'the guide had no programmes for your channels';
    status.ms = Date.now() - t0; saveStatus(sourceId, status);
    log.warn(`Guide (EPG) for source ${sourceId}: ${status.error}`);
    return status;
  }
  // swap in: new programmes replace everything from the start of the new guide; older ones (catch-up) are kept
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM programmes WHERE source_id = ? AND start >= ?').run(sourceId, minStart);
    d.prepare('INSERT OR REPLACE INTO programmes SELECT * FROM stage WHERE source_id = ?').run(sourceId);
    d.prepare('DELETE FROM stage WHERE source_id = ?').run(sourceId);
    d.prepare('DELETE FROM programmes WHERE source_id = ? AND stop < ?').run(sourceId, now - BACK_ARCHIVE);
    if (wanted) { // channels nobody can see any more
      const keep = new Set(wanted.keys());
      const del = d.prepare('DELETE FROM programmes WHERE source_id = ? AND ch = ?');
      for (const r of d.prepare('SELECT DISTINCT ch FROM programmes WHERE source_id = ?').all(sourceId)) if (!keep.has(r.ch)) del.run(sourceId, r.ch);
    }
    d.prepare('DELETE FROM channels WHERE source_id = ?').run(sourceId);
    const ci = d.prepare('INSERT OR REPLACE INTO channels (source_id, ch, name, icon) VALUES (?,?,?,?)');
    for (const id of new Set([...seen, ...chans.keys()])) { const c = chans.get(id); ci.run(sourceId, id, c?.name || null, c?.icon || null); if (c?.icon) status.icons++; }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  status.ok = true; status.lastOkAt = now; status.channels = seen.size; status.programmes = n; status.ms = Date.now() - t0;
  saveStatus(sourceId, status);
  log.log(`Guide (EPG) for source ${sourceId}: ${seen.size} channels, ${n} programmes, ${status.icons} icons in ${Math.round(status.ms / 1000)} s`);
  return status;
}

function saveStatus(sourceId, s) { db.prepare('INSERT OR REPLACE INTO status (source_id, json) VALUES (?, ?)').run(sourceId, JSON.stringify(s)); }
function status(sourceId) {
  if (!db) return null;
  const r = db.prepare('SELECT json FROM status WHERE source_id = ?').get(sourceId);
  try { return r ? JSON.parse(r.json) : null; } catch { return null; }
}
/** last successful refresh (ms) for a source, or 0 */
function lastOk(sourceId) {
  const s = status(sourceId);
  if (s?.ok) return s.at;
  return s?.lastOkAt || 0;
}

// ------------------------------------------------------------------ reading

const known = (sourceId, ch) => !!db?.prepare('SELECT 1 FROM channels WHERE source_id = ? AND ch = ?').get(sourceId, ch);
function hasGuide(sourceId) { return !!db?.prepare('SELECT 1 FROM channels WHERE source_id = ? LIMIT 1').get(sourceId); }

/** programmes for one channel: [[startSec, stopSec, title, desc|null], …] */
function forChannel(sourceId, ch, from, to) {
  return db.prepare('SELECT start, stop, title, descr FROM programmes WHERE source_id = ? AND ch = ? AND stop > ? AND start < ? ORDER BY start')
    .all(sourceId, ch, from, to).map((r) => [Math.round(r.start / 1000), Math.round(r.stop / 1000), r.title, r.descr ?? null]);
}

/** upcoming programmes whose title contains q, limited to the given guide ids (lower case) */
function search(sourceId, q, ids, limit = 150) {
  const like = '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = db.prepare("SELECT ch, start, stop, title FROM programmes WHERE source_id = ? AND stop > ? AND title LIKE ? ESCAPE '\\' ORDER BY start LIMIT 5000")
    .all(sourceId, Date.now(), like);
  const out = [];
  for (const r of rows) { if (ids && !ids.has(r.ch)) continue; out.push([r.ch, Math.round(r.start / 1000), Math.round(r.stop / 1000), r.title]); if (out.length >= limit) break; }
  return out;
}

/** epg id -> icon url, for channels the provider sent without a logo */
function icons(sourceId) {
  if (!db) return {};
  const out = {};
  for (const r of db.prepare('SELECT ch, icon FROM channels WHERE source_id = ? AND icon IS NOT NULL').all(sourceId)) out[r.ch] = r.icon;
  return out;
}

function counts(sourceId) {
  if (!db) return { channels: 0, programmes: 0 };
  return {
    channels: db.prepare('SELECT COUNT(*) n FROM channels WHERE source_id = ?').get(sourceId).n,
    programmes: db.prepare('SELECT COUNT(*) n FROM programmes WHERE source_id = ?').get(sourceId).n,
    until: db.prepare('SELECT MAX(stop) m FROM programmes WHERE source_id = ?').get(sourceId).m || null,
  };
}

function forget(sourceId) {
  if (!db) return;
  for (const t of ['programmes', 'stage', 'channels', 'status']) db.prepare(`DELETE FROM ${t} WHERE source_id = ?`).run(sourceId);
}

module.exports = { open, refreshSource, parseXmltv, xmltvTime, unxml, status, lastOk, known, hasGuide, forChannel, search, icons, counts, forget, MAX_CHANNELS };
