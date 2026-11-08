'use strict';
/*
 * TiviSync server – sync + parental controls backend for the TiviSync Android TV app.
 * Zero npm dependencies: Node 22+ (node:http, node:sqlite, node:crypto).
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Home Assistant add-on: options from the add-on UI land in /data/options.json
try {
  const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
  for (const [k, v] of Object.entries(opts)) {
    const key = k.toUpperCase();
    if (v !== '' && v != null && process.env[key] === undefined) process.env[key] = String(v);
  }
  if (!process.env.DATA_DIR) process.env.DATA_DIR = '/data';
} catch { /* not running as an HA add-on */ }

const { db, DATA_DIR } = require('./db');
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 8080);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TZ = process.env.TZ || 'Europe/London';
process.env.TZ = TZ; // so the 3am nightly job and day boundaries use local time
const NTFY_URL = process.env.NTFY_URL || ''; // e.g. https://ntfy.sh/my-secret-topic
const HA_WEBHOOK_URL = process.env.HA_WEBHOOK_URL || ''; // e.g. http://homeassistant.local:8123/api/webhook/tivisync_xyz
const API_TOKEN = process.env.API_TOKEN || ''; // optional static parent token (for Home Assistant rest_command)
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';         // read-only token for the private app repo
const GITHUB_REPO = process.env.GITHUB_REPO || 'efrhub/tivisync';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  if (process.env.HA_INGRESS === '1') {
    console.warn('No admin_password set: parent app only available from the Home Assistant sidebar.');
  } else {
    console.error('ADMIN_PASSWORD env var must be set (min 8 chars).');
    process.exit(1);
  }
}

// ---------- helpers ----------
const now = () => Date.now();
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const today = (ts = now()) => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const dayOffset = (n) => today(now() - n * 86400000);

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function checkPin(pin, stored) {
  if (!stored) return true;
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(String(pin ?? ''), Buffer.from(s, 'hex'), 32);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// simple in-memory rate limiter for PIN / password attempts
const attempts = new Map();
function rateLimit(key, max = 5, windowMs = 5 * 60 * 1000) {
  const t = now();
  const a = (attempts.get(key) || []).filter((x) => t - x < windowMs);
  if (a.length >= max) throw new HttpError(429, 'Too many attempts – wait a few minutes');
  a.push(t);
  attempts.set(key, a);
}
const clearAttempts = (key) => attempts.delete(key);

function notify(title, message, data = {}) {
  if (HA_WEBHOOK_URL) {
    fetch(HA_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, message, ...data }) })
      .catch((e) => console.warn('HA webhook failed', e.message));
  }
  if (!NTFY_URL) return;
  fetch(NTFY_URL, {
    method: 'POST',
    headers: {
      Title: title,
      Tags: 'tv',
      Priority: 'high',
      ...(PUBLIC_URL ? { Click: `${PUBLIC_URL}/parent/` } : {}),
    },
    body: message,
  }).catch((e) => console.warn('ntfy failed', e.message));
}

// ---------- domain ----------
function profileRow(p, includeAdmin = false) {
  const out = {
    id: p.id,
    name: p.name,
    color: p.color,
    hasPin: !!p.pin_hash,
    isChild: !!p.is_child,
    dailyLimitMin: p.daily_limit_min,
    blockedKeywords: p.blocked_keywords ? p.blocked_keywords.split(',').map((s) => s.trim()).filter(Boolean) : [],
    maxAge: p.max_age ?? null, // age-rating limit for films/series (null = no limit)
    watchHours: parseHours(p.watch_hours), // 7 entries Mon..Sun: null = any time, {from,to} "HH:MM", or "off"
  };
  if (includeAdmin) out.createdAt = p.created_at;
  return out;
}

const HOSTED = 'hosted:';
const hostedPath = (v) => (v && v.startsWith(HOSTED) ? `/api/tv/files/${v.slice(HOSTED.length)}` : v);
function sourceRow(s) {
  return { id: s.id, name: s.name, type: s.type, url: hostedPath(s.url), hostedM3u: !!s.url?.startsWith(HOSTED),
    hostedEpg: !!s.epg_url?.startsWith(HOSTED), updatedAt: s.updated_at || s.created_at, username: s.username, password: s.password, epgUrl: hostedPath(s.epg_url), requiredIp: s.required_ip || null,
    backupUrls: s.backup_urls ? JSON.parse(s.backup_urls) : [] };
}

// ---------- viewing hours (e.g. kids 09:00–21:00, set per day) ----------
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function parseHours(raw) {
  try { const a = raw ? JSON.parse(raw) : null; return Array.isArray(a) && a.length === 7 ? a : null; } catch { return null; }
}
function validateHours(v) {
  if (v === null || v === '') return null;
  if (!Array.isArray(v) || v.length !== 7) throw new HttpError(400, 'Viewing hours need an entry for each day');
  const out = v.map((d, i) => {
    if (d === null || d === undefined || d === '' || d === 'any') return null;
    if (d === 'off') return 'off';
    if (!HHMM.test(String(d.from)) || !HHMM.test(String(d.to))) throw new HttpError(400, `${DAY_NAMES[i]}: times must look like 09:00`);
    if (d.from === d.to) throw new HttpError(400, `${DAY_NAMES[i]}: start and end are the same – choose "No TV" instead`);
    return { from: d.from, to: d.to };
  });
  return out.every((d) => d === null) ? null : JSON.stringify(out);
}
const dayIndex = (d) => (d.getDay() + 6) % 7; // Monday = 0
function midnight(t, addDays = 0) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + addDays); return d; }
function atTime(day, hhmm) { const [h, m] = hhmm.split(':').map(Number); const d = new Date(day); d.setHours(h, m, 0, 0); return d.getTime(); }
/**
 * Works out whether a profile may watch right now under its viewing hours. Extra time given today also lets
 * them watch that much past today's end time. Returns null when the profile has no viewing hours.
 */
function hoursCheck(hours, bonusSec, t = now()) {
  if (!hours) return null;
  const spans = [];
  for (let k = -1; k <= 2; k++) {
    const day = midnight(t, k);
    const w = hours[dayIndex(day)];
    if (w === 'off') continue;
    if (w === null) { spans.push([day.getTime(), midnight(day, 1).getTime()]); continue; }
    let s = atTime(day, w.from), e = atTime(day, w.to);
    if (e <= s) e = atTime(midnight(day, 1), w.to); // overnight, e.g. 18:00–01:00
    if (k === 0 && bonusSec > 0) e += bonusSec * 1000;
    spans.push([s, e]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) { const last = merged[merged.length - 1]; if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]); }
  const inside = merged.find(([s, e]) => s <= t && t < e);
  const w = hours[dayIndex(new Date(t))];
  const todayText = w === 'off' ? `No TV on ${DAY_NAMES[dayIndex(new Date(t))]}s` : w ? `TV time today is ${w.from}–${w.to}` : null;
  if (inside) return { allowed: true, endsAt: inside[1], secondsLeft: Math.max(0, Math.round((inside[1] - t) / 1000)), message: todayText };
  const next = merged.find(([s]) => s > t);
  const fmt = (ms) => new Date(ms).toTimeString().slice(0, 5);
  const nextText = next ? (midnight(next[0]).getTime() === midnight(t).getTime() ? ` – back on at ${fmt(next[0])}` : ` – back on ${DAY_NAMES[dayIndex(new Date(next[0]))]} at ${fmt(next[0])}`) : '';
  // before today's start time, extra minutes won't help; after the end time they extend it
  const afterEnd = w && w !== 'off' && t >= atTime(midnight(t), w.from);
  return { allowed: false, endsAt: null, secondsLeft: 0, nextStart: next ? next[0] : null, canExtend: !!afterEnd,
    message: (todayText || 'Outside TV time') + nextText };
}

function allowance(profileId) {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  if (!p) throw new HttpError(404, 'Profile not found');
  const u = db.prepare('SELECT seconds, bonus_seconds FROM usage_daily WHERE profile_id = ? AND day = ?').get(profileId, today()) || { seconds: 0, bonus_seconds: 0 };
  const pending = db.prepare("SELECT id FROM time_requests WHERE profile_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(profileId);
  const hc = hoursCheck(parseHours(p.watch_hours), u.bonus_seconds);
  const base = { usedSec: u.seconds, bonusSec: u.bonus_seconds, pendingRequestId: pending?.id ?? null,
    hoursMessage: hc?.message ?? null, windowEndsAt: hc?.endsAt ?? null };
  if (hc && !hc.allowed) {
    return { ...base, limited: true, allowed: false, reason: 'hours', canAsk: hc.canExtend, nextStart: hc.nextStart,
      limitSec: p.daily_limit_min == null ? null : p.daily_limit_min * 60 + u.bonus_seconds, remainingSec: 0, message: hc.message };
  }
  const windowLeft = hc ? hc.secondsLeft : null;
  if (p.daily_limit_min == null) {
    // only viewing hours: "remaining" is the time until the end of the current TV time (null when it's a no-limit day)
    const limitedByHours = windowLeft != null && windowLeft < 24 * 3600;
    return { ...base, limited: limitedByHours, allowed: true, reason: null, canAsk: true, limitSec: null,
      remainingSec: limitedByHours ? windowLeft : null };
  }
  const limitSec = p.daily_limit_min * 60 + u.bonus_seconds;
  const byLimit = Math.max(0, limitSec - u.seconds);
  const remainingSec = windowLeft != null ? Math.min(byLimit, windowLeft) : byLimit;
  return { ...base, limited: true, allowed: remainingSec > 0, reason: remainingSec > 0 ? null : 'limit', canAsk: true,
    limitSec, remainingSec, message: remainingSec > 0 ? null : 'Daily TV time used up' };
}

function addBonus(profileId, minutes) {
  db.prepare(`INSERT INTO usage_daily (profile_id, day, seconds, bonus_seconds) VALUES (?, ?, 0, ?)
    ON CONFLICT(profile_id, day) DO UPDATE SET bonus_seconds = bonus_seconds + excluded.bonus_seconds`)
    .run(profileId, today(), Math.round(minutes * 60));
}

// ---------- router ----------
const routes = [];
function route(method, pattern, auth, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, auth, handler, raw: !!opts.raw });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new HttpError(413, 'Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  // via the Home Assistant remote proxy (Nabu Casa) the device token travels in its own header,
  // because Home Assistant treats Authorization as its own login
  const x = req.headers['x-tivisync-device'];
  return typeof x === 'string' && x ? x : null;
}

function authAdmin(req) {
  const t = bearer(req);
  if (t && API_TOKEN.length >= 16 && safeEqual(t, API_TOKEN)) return {};
  // Home Assistant ingress: HA has already authenticated the user; requests come from the supervisor proxy
  const ra = (req.socket.remoteAddress || '').replace('::ffff:', '');
  if (process.env.HA_INGRESS === '1' && ra === '172.30.32.2' && req.headers['x-ingress-path']) return {};
  const s = t && db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(t);
  if (!s || s.expires_at < now()) throw new HttpError(401, 'Parent login required');
  return {};
}
function authDevice(req) {
  const t = bearer(req);
  const d = t && db.prepare('SELECT * FROM devices WHERE token = ?').get(t);
  if (!d) throw new HttpError(401, 'Device not paired');
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), d.id);
  return { device: d };
}
function authProfile(req) {
  const ctx = authDevice(req);
  const pt = req.headers['x-profile-token'];
  const s = pt && db.prepare('SELECT * FROM profile_sessions WHERE token = ? AND device_id = ?').get(pt, ctx.device.id);
  if (!s) throw new HttpError(401, 'Profile login required');
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(s.profile_id);
  if (!profile) throw new HttpError(401, 'Profile login required');
  return { ...ctx, profile };
}
function authDeviceOrQuery(req) {
  // allows ?t=<deviceToken> so the TV's playlist loader can fetch hosted files with a plain URL
  const t = new URL(req.url, 'http://x').searchParams.get('t');
  if (t && !req.headers.authorization) req.headers.authorization = 'Bearer ' + t;
  return authDevice(req);
}
const AUTH = { none: () => ({}), admin: authAdmin, device: authDevice, deviceOrQuery: authDeviceOrQuery, profile: authProfile };

// =====================================================================
// Parent (admin) API – used by the phone web app
// =====================================================================
route('POST', '/api/admin/login', 'none', async (req, body) => {
  const ip = req.socket.remoteAddress;
  rateLimit('admin:' + ip, 8);
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) throw new HttpError(401, 'Password login is off – open TiviSync from the Home Assistant sidebar');
  if (!safeEqual(body.password || '', ADMIN_PASSWORD)) throw new HttpError(401, 'Wrong password');
  clearAttempts('admin:' + ip);
  const t = token();
  db.prepare('INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)').run(t, now() + 180 * 86400000);
  return { token: t };
});

route('POST', '/api/admin/logout', 'admin', async (req) => {
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(bearer(req));
  return { ok: true };
});

route('GET', '/api/admin/overview', 'admin', async () => {
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY id').all().map((p) => ({ ...profileRow(p, true), today: allowance(p.id) }));
  const devices = db.prepare(`SELECT d.*, p.name AS now_profile FROM devices d LEFT JOIN profiles p ON p.id = d.now_profile_id ORDER BY d.id`).all()
    .map((d) => ({
      id: d.id, name: d.name, lastSeen: d.last_seen, createdAt: d.created_at, hasVpnConfig: !!d.wg_config,
      nowPlaying: d.now_at && now() - d.now_at < 90_000 ? { profile: d.now_profile, title: d.now_title, at: d.now_at } : null,
    }));
  const requests = db.prepare(`SELECT r.*, p.name AS profile_name, d.name AS device_name FROM time_requests r
     JOIN profiles p ON p.id = r.profile_id LEFT JOIN devices d ON d.id = r.device_id
     WHERE r.status = 'pending' ORDER BY r.id DESC`).all();
  return { profiles, devices, requests, vpn: vpnSettings(), serverTime: now(), today: today() };
});

// --- profiles ---
function validateProfile(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) {
    if (!b.name || String(b.name).trim().length < 1) throw new HttpError(400, 'Name required');
    out.name = String(b.name).trim().slice(0, 30);
  }
  if (b.color !== undefined) out.color = /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#3b82f6';
  if (b.isChild !== undefined) out.is_child = b.isChild ? 1 : 0;
  if (b.dailyLimitMin !== undefined) {
    out.daily_limit_min = b.dailyLimitMin === null || b.dailyLimitMin === '' ? null : Math.max(0, Math.min(1440, Number(b.dailyLimitMin) | 0));
  }
  if (b.maxAge !== undefined) {
    const a = b.maxAge === null || b.maxAge === '' ? null : Number(b.maxAge);
    if (a !== null && ![0, 8, 12, 15].includes(a)) throw new HttpError(400, 'Age limit must be U, PG, 12 or 15');
    out.max_age = a;
  }
  if (b.watchHours !== undefined) out.watch_hours = validateHours(b.watchHours);
  if (b.blockedKeywords !== undefined) {
    const arr = Array.isArray(b.blockedKeywords) ? b.blockedKeywords : String(b.blockedKeywords).split(',');
    out.blocked_keywords = arr.map((s) => String(s).trim()).filter(Boolean).join(',');
  }
  if (b.pin !== undefined) {
    if (b.pin === null || b.pin === '') out.pin_hash = null;
    else if (!/^\d{4,8}$/.test(String(b.pin))) throw new HttpError(400, 'PIN must be 4–8 digits');
    else out.pin_hash = hashPin(b.pin);
  }
  return out;
}

route('POST', '/api/admin/profiles', 'admin', async (req, b) => {
  const v = validateProfile(b, false);
  const r = db.prepare(`INSERT INTO profiles (name, color, pin_hash, is_child, daily_limit_min, blocked_keywords, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(v.name, v.color || '#3b82f6', v.pin_hash ?? null, v.is_child ?? 0, v.daily_limit_min ?? null, v.blocked_keywords ?? '', now());
  if (v.max_age !== undefined) db.prepare('UPDATE profiles SET max_age = ? WHERE id = ?').run(v.max_age, r.lastInsertRowid);
  if (v.watch_hours !== undefined) db.prepare('UPDATE profiles SET watch_hours = ? WHERE id = ?').run(v.watch_hours, r.lastInsertRowid);
  return profileRow(db.prepare('SELECT * FROM profiles WHERE id = ?').get(r.lastInsertRowid), true);
});

route('PATCH', '/api/admin/profiles/:id', 'admin', async (req, b, { id }) => {
  const v = validateProfile(b, true);
  const keys = Object.keys(v);
  if (keys.length) db.prepare(`UPDATE profiles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => v[k]), id);
  if (v.pin_hash !== undefined) db.prepare('DELETE FROM profile_sessions WHERE profile_id = ?').run(id); // force re-login with new PIN
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'Profile not found');
  return profileRow(p, true);
});

route('DELETE', '/api/admin/profiles/:id', 'admin', async (req, b, { id }) => {
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  return { ok: true };
});

// --- time ---
route('POST', '/api/admin/profiles/:id/bonus', 'admin', async (req, b, { id }) => {
  const minutes = Number(b.minutes);
  if (!Number.isFinite(minutes) || minutes === 0 || Math.abs(minutes) > 600) throw new HttpError(400, 'minutes must be between -600 and 600');
  addBonus(Number(id), minutes);
  // approving any pending requests for this profile
  db.prepare(`UPDATE time_requests SET status = 'approved', granted_minutes = ?, decided_at = ? WHERE profile_id = ? AND status = 'pending'`)
    .run(minutes, now(), id);
  return allowance(Number(id));
});

route('POST', '/api/admin/profiles/:id/reset-today', 'admin', async (req, b, { id }) => {
  db.prepare('UPDATE usage_daily SET seconds = 0 WHERE profile_id = ? AND day = ?').run(id, today());
  return allowance(Number(id));
});

route('POST', '/api/admin/requests/:id', 'admin', async (req, b, { id }) => {
  const r = db.prepare('SELECT * FROM time_requests WHERE id = ?').get(id);
  if (!r) throw new HttpError(404, 'Request not found');
  if (r.status !== 'pending') return { ok: true, status: r.status };
  if (b.approve) {
    const minutes = Math.max(5, Math.min(600, Math.round((Number(b.minutes || r.minutes) || 0) / 5) * 5));
    addBonus(r.profile_id, minutes);
    db.prepare(`UPDATE time_requests SET status='approved', granted_minutes=?, decided_at=? WHERE id=?`).run(minutes, now(), id);
  } else {
    db.prepare(`UPDATE time_requests SET status='denied', decided_at=? WHERE id=?`).run(now(), id);
  }
  return { ok: true };
});

// --- usage ---
route('GET', '/api/admin/usage', 'admin', async (req) => {
  const u = new URL(req.url, 'http://x');
  const days = Math.max(1, Math.min(90, Number(u.searchParams.get('days') || 7)));
  const from = dayOffset(days - 1);
  const daily = db.prepare('SELECT profile_id AS profileId, day, seconds, bonus_seconds AS bonusSeconds FROM usage_daily WHERE day >= ? ORDER BY day').all(from);
  const sessions = db.prepare(`SELECT s.id, s.profile_id AS profileId, p.name AS profile, d.name AS device, s.type, s.title,
      s.started_at AS startedAt, s.last_at AS lastAt, s.seconds
    FROM usage_sessions s JOIN profiles p ON p.id = s.profile_id LEFT JOIN devices d ON d.id = s.device_id
    WHERE s.started_at >= ? ORDER BY s.started_at DESC LIMIT 300`).all(now() - days * 86400000);
  const requests = db.prepare(`SELECT r.id, p.name AS profile, r.minutes, r.message, r.status, r.granted_minutes AS grantedMinutes,
      r.created_at AS createdAt, r.decided_at AS decidedAt
    FROM time_requests r JOIN profiles p ON p.id = r.profile_id WHERE r.created_at >= ? ORDER BY r.id DESC LIMIT 100`).all(now() - days * 86400000);
  return { from, to: today(), daily, sessions, requests };
});

// --- sources ---
function validateSource(b) {
  const type = b.type === 'm3u' ? 'm3u' : 'xtream';
  const hostedM3u = type === 'm3u' && (b.hostedM3u || b.url === '' || b.url == null);
  if (!hostedM3u && (!b.url || !/^https?:\/\//i.test(b.url))) throw new HttpError(400, 'URL must start with http:// or https://');
  if (type === 'xtream' && (!b.username || !b.password)) throw new HttpError(400, 'Xtream needs username and password');
  const out = {
    name: String(b.name || (type === 'xtream' ? 'Xtream' : 'M3U')).slice(0, 40),
    type,
    url: hostedM3u ? null : String(b.url).trim().replace(/\/+$/, type === 'xtream' ? '' : '$&'),
    username: b.username ? String(b.username).trim() : null,
    password: b.password ? String(b.password) : null,
    epg_url: b.hostedEpg ? null : b.epgUrl ? String(b.epgUrl).trim() : null,
    required_ip: b.requiredIp ? String(b.requiredIp).trim() : null,
    // extra addresses for the same provider (IPTV services usually hand out several DNS names) – the app fails over
    backup_urls: (() => {
      const raw = Array.isArray(b.backupUrls) ? b.backupUrls : String(b.backupUrls || '').split(/[\s,]+/);
      const list = [...new Set(raw.map((u) => String(u).trim().replace(/\/+$/, '')).filter(Boolean))];
      for (const u of list) if (!/^https?:\/\/[^\s]+$/i.test(u)) throw new HttpError(400, `Backup address must start with http:// or https:// (${u})`);
      return list.length ? JSON.stringify(list.slice(0, 10)) : null;
    })(),
  };
  if (out.required_ip && !/^[0-9a-fA-F:.]{3,45}$/.test(out.required_ip)) throw new HttpError(400, 'Required IP is not a valid IP address');
  return out;
}
route('GET', '/api/admin/sources', 'admin', async () => db.prepare('SELECT * FROM sources ORDER BY id').all().map(sourceRow));
route('POST', '/api/admin/sources', 'admin', async (req, b) => {
  const v = validateSource(b);
  if (v.url === null) v.url = HOSTED + 'pending';
  const r = db.prepare('INSERT INTO sources (name, type, url, username, password, epg_url, required_ip, backup_urls, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(v.name, v.type, v.url, v.username, v.password, v.epg_url, v.required_ip, v.backup_urls, now());
  return sourceRow(db.prepare('SELECT * FROM sources WHERE id = ?').get(r.lastInsertRowid));
});
route('PUT', '/api/admin/sources/:id', 'admin', async (req, b, { id }) => {
  const v = validateSource(b);
  const old = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  if (!old) throw new HttpError(404, 'Source not found');
  if (v.url === null) v.url = old.url?.startsWith(HOSTED) ? old.url : HOSTED + 'pending';
  if (v.epg_url === null && b.hostedEpg && old.epg_url?.startsWith(HOSTED)) v.epg_url = old.epg_url;
  db.prepare('UPDATE sources SET name=?, type=?, url=?, username=?, password=?, epg_url=?, required_ip=?, backup_urls=?, updated_at=? WHERE id=?')
    .run(v.name, v.type, v.url, v.username, v.password, v.epg_url, v.required_ip, v.backup_urls, now(), id);
  return sourceRow(db.prepare('SELECT * FROM sources WHERE id = ?').get(id));
});
route('DELETE', '/api/admin/sources/:id', 'admin', async (req, b, { id }) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  for (const f of fs.readdirSync(FILES_DIR)) if (f.startsWith(`source-${Number(id)}-`)) fs.rmSync(path.join(FILES_DIR, f), { force: true });
  return { ok: true };
});

// --- uploaded playlist / EPG files (stored on this server, e.g. Home Assistant) ---
const MAX_UPLOAD = 300 * 1024 * 1024;
route('POST', '/api/admin/sources/:id/file', 'admin', async (req, b, { id }) => {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  if (!src) throw new HttpError(404, 'Source not found');
  const kind = new URL(req.url, 'http://x').searchParams.get('kind') === 'epg' ? 'epg' : 'm3u';
  const name = `source-${src.id}-${kind}.${kind === 'epg' ? 'xml' : 'm3u'}`;
  const tmp = path.join(FILES_DIR, name + '.upload');
  await new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(tmp);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { req.destroy(); out.destroy(); reject(new HttpError(413, 'File too large (max 300 MB)')); }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  });
  if (kind === 'm3u') {
    const head = Buffer.alloc(200);
    const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 200, 0); fs.closeSync(fd);
    if (!head.toString('utf8').includes('#EXT')) { fs.rmSync(tmp, { force: true }); throw new HttpError(400, "That doesn't look like an M3U playlist"); }
  }
  fs.renameSync(tmp, path.join(FILES_DIR, name));
  const col = kind === 'epg' ? 'epg_url' : 'url';
  db.prepare(`UPDATE sources SET ${col} = ?, updated_at = ? WHERE id = ?`).run(HOSTED + name, now(), src.id);
  return sourceRow(db.prepare('SELECT * FROM sources WHERE id = ?').get(src.id));
}, { raw: true });

route('GET', '/api/tv/files/:name', 'deviceOrQuery', async (req, b, { name }, ctx, res) => {
  if (!/^source-\d+-(m3u|epg)\.(m3u|xml)$/.test(name)) throw new HttpError(404, 'Not found');
  const file = path.join(FILES_DIR, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File not uploaded yet');
  const st = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': name.endsWith('.xml') ? 'application/xml' : 'audio/x-mpegurl', 'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(), 'Cache-Control': 'no-cache' });
  await new Promise((resolve) => fs.createReadStream(file).on('end', resolve).on('error', resolve).pipe(res));
  return undefined;
});

// --- settings: streaming VPN (WireGuard, e.g. Surfshark dedicated IP) ---
const getSetting = (k, d = null) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? d;
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v == null ? null : String(v));
function validateWg(cfg) {
  if (cfg == null || String(cfg).trim() === '') return null;
  const t = String(cfg).trim();
  if (!/\[Interface\]/i.test(t) || !/\[Peer\]/i.test(t) || !/PrivateKey\s*=/i.test(t)) throw new HttpError(400, 'Paste the whole WireGuard .conf file ([Interface] and [Peer] sections)');
  if (t.length > 8000) throw new HttpError(400, 'Config too long');
  return t;
}
function vpnSettings() {
  return { required: getSetting('vpn_required') === '1', dedicatedIp: getSetting('vpn_dedicated_ip'), hasDefaultConfig: !!getSetting('vpn_default_config'),
    homeOnly: getSetting('vpn_home_only', '1') === '1' }; // default: VPN only on the home network
}
route('GET', '/api/admin/settings', 'admin', async () => ({ vpn: vpnSettings() }));
route('PUT', '/api/admin/settings', 'admin', async (req, b) => {
  const v = b.vpn || {};
  if (v.required !== undefined) setSetting('vpn_required', v.required ? '1' : '0');
  if (v.homeOnly !== undefined) setSetting('vpn_home_only', v.homeOnly ? '1' : '0');
  if (v.dedicatedIp !== undefined) {
    const ip = String(v.dedicatedIp || '').trim();
    if (ip && !/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw new HttpError(400, 'Dedicated IP is not a valid IP address');
    setSetting('vpn_dedicated_ip', ip || null);
  }
  if (v.defaultConfig !== undefined) setSetting('vpn_default_config', validateWg(v.defaultConfig));
  return { vpn: vpnSettings() };
});

// --- app updates: HA fetches new APK builds from GitHub, devices update from HA ---
const APP_DIR = path.join(DATA_DIR, 'app');
fs.mkdirSync(APP_DIR, { recursive: true });
const APK_FILE = path.join(APP_DIR, 'TiviSync.apk');
const APP_META = path.join(APP_DIR, 'meta.json');
function appMeta() { try { return JSON.parse(fs.readFileSync(APP_META, 'utf8')); } catch { return null; } }
let lastAppCheck = { at: null, result: null };

async function checkGithubRelease() {
  if (!GITHUB_TOKEN) { lastAppCheck = { at: now(), result: 'No GitHub token set in the add-on configuration' }; return lastAppCheck; }
  const gh = (u, accept = 'application/vnd.github+json') => fetch(u, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: accept, 'User-Agent': 'TiviSync-HA', 'X-GitHub-Api-Version': '2022-11-28' } });
  try {
    const r = await gh(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const rel = await r.json();
    const versionCode = Number(String(rel.tag_name || '').replace(/\D+/g, '')) || 0;
    const asset = (rel.assets || []).find((a) => a.name.endsWith('.apk'));
    if (!asset) throw new Error('Latest release has no APK');
    const cur = appMeta();
    if (cur && cur.versionCode >= versionCode && fs.existsSync(APK_FILE)) {
      lastAppCheck = { at: now(), result: `Up to date (build ${cur.versionCode})` }; return lastAppCheck;
    }
    const d = await gh(asset.url, 'application/octet-stream');
    if (!d.ok) throw new Error(`APK download failed (${d.status})`);
    const buf = Buffer.from(await d.arrayBuffer());
    if (buf.length < 100000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('Downloaded file is not an APK');
    fs.writeFileSync(APK_FILE + '.tmp', buf); fs.renameSync(APK_FILE + '.tmp', APK_FILE);
    const meta = { versionCode, versionName: rel.name || rel.tag_name, size: buf.length, publishedAt: rel.published_at, source: 'github' };
    fs.writeFileSync(APP_META, JSON.stringify(meta));
    lastAppCheck = { at: now(), result: `Downloaded build ${versionCode}` };
  } catch (e) { lastAppCheck = { at: now(), result: 'Check failed: ' + e.message }; }
  return lastAppCheck;
}
setTimeout(checkGithubRelease, 15_000).unref();
setInterval(checkGithubRelease, 30 * 60_000).unref();

route('GET', '/api/admin/app', 'admin', async () => ({ app: appMeta(), lastCheck: lastAppCheck, tokenSet: !!GITHUB_TOKEN, repo: GITHUB_REPO }));
route('POST', '/api/admin/app/check', 'admin', async () => ({ ...(await checkGithubRelease()), app: appMeta() }));
// manual fallback: upload an APK from the parent panel (?version=N)
route('POST', '/api/admin/app/upload', 'admin', async (req) => {
  const versionCode = Number(new URL(req.url, 'http://x').searchParams.get('version')) || ((appMeta()?.versionCode || 0) + 1);
  const chunks = []; let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => { size += c.length; if (size > 200 * 1024 * 1024) { req.destroy(); reject(new HttpError(413, 'APK too large')); } else chunks.push(c); });
    req.on('end', resolve); req.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (buf.length < 100000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new HttpError(400, "That doesn't look like an APK file");
  fs.writeFileSync(APK_FILE, buf);
  const meta = { versionCode, versionName: `build ${versionCode}`, size: buf.length, publishedAt: new Date().toISOString(), source: 'upload' };
  fs.writeFileSync(APP_META, JSON.stringify(meta));
  return { app: meta };
}, { raw: true });

// ---------- backup / restore (moving to a new Home Assistant add-on, or a safety copy) ----------
// The backup is one JSON file: the whole database plus any uploaded playlist / EPG files.
route('GET', '/api/admin/backup', 'admin', async (req, b, p, ctx, res) => {
  const tmp = path.join(DATA_DIR, `backup-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const files = {};
    if (fs.existsSync(FILES_DIR)) for (const f of fs.readdirSync(FILES_DIR)) {
      if (/^source-\d+-(m3u|epg)\.(m3u|xml)$/.test(f)) files[f] = fs.readFileSync(path.join(FILES_DIR, f)).toString('base64');
    }
    const out = Buffer.from(JSON.stringify({ format: 'tivisync-backup', version: 1, createdAt: new Date().toISOString(),
      db: fs.readFileSync(tmp).toString('base64'), files }));
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': out.length,
      'Content-Disposition': `attachment; filename="tivisync-backup-${stamp}.json"` });
    res.end(out);
    return undefined;
  } finally { fs.rmSync(tmp, { force: true }); }
});

function restoreBackup(bk) {
  if (!bk || bk.format !== 'tivisync-backup' || typeof bk.db !== 'string') throw new HttpError(400, "That isn't a TiviSync backup file");
  const buf = Buffer.from(bk.db, 'base64');
  if (buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new HttpError(400, 'The backup file is damaged');
  const tmp = path.join(DATA_DIR, `restore-${Date.now()}.db`);
  fs.writeFileSync(tmp, buf);
  const copied = {};
  try {
    db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS r`);
    try {
      const mine = db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
      const theirs = new Set(db.prepare("SELECT name FROM r.sqlite_master WHERE type = 'table'").all().map((t) => t.name));
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        for (const t of mine) {
          if (!theirs.has(t)) continue;
          const q = (n) => '"' + n.replace(/"/g, '""') + '"';
          const a = db.prepare(`PRAGMA main.table_info(${q(t)})`).all().map((c) => c.name);
          const bcols = new Set(db.prepare(`PRAGMA r.table_info(${q(t)})`).all().map((c) => c.name));
          const cols = a.filter((c) => bcols.has(c)).map(q).join(', ');
          db.exec(`DELETE FROM main.${q(t)}`);
          if (cols) db.exec(`INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM r.${q(t)}`);
          copied[t] = db.prepare(`SELECT COUNT(*) n FROM main.${q(t)}`).get().n;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      finally { db.exec('PRAGMA foreign_keys = ON'); }
    } finally { db.exec('DETACH DATABASE r'); }
  } finally { fs.rmSync(tmp, { force: true }); }
  fs.mkdirSync(FILES_DIR, { recursive: true });
  for (const [name, data] of Object.entries(bk.files || {})) {
    if (/^source-\d+-(m3u|epg)\.(m3u|xml)$/.test(name)) fs.writeFileSync(path.join(FILES_DIR, name), Buffer.from(String(data), 'base64'));
  }
  return copied;
}
route('POST', '/api/admin/restore', 'admin', async (req) => {
  const chunks = []; let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { req.destroy(); reject(new HttpError(413, 'Backup too large')); } else chunks.push(c); });
    req.on('end', resolve); req.on('error', reject);
  });
  let bk;
  try { bk = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, "That isn't a TiviSync backup file"); }
  const tables = restoreBackup(bk);
  return { ok: true, tables, restartAdvised: true };
}, { raw: true });

route('GET', '/api/tv/app', 'device', async () => ({ app: appMeta() }));
route('GET', '/api/tv/app/apk', 'deviceOrQuery', async (req, b, p, ctx, res) => {
  if (!fs.existsSync(APK_FILE)) throw new HttpError(404, 'No app build available on the server yet');
  const st = fs.statSync(APK_FILE);
  res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="TiviSync.apk"' });
  await new Promise((resolve) => fs.createReadStream(APK_FILE).on('end', resolve).on('error', resolve).pipe(res));
  return undefined;
});

// Easy install on a new TV: open http://<HA-IP>:8080/tv in the TV's Downloader app.
// Home network only (the Nabu Casa bridge doesn't forward these paths, and outside addresses are refused).
function fromHomeNetwork(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:|fd)/i.test(ip);
}
async function sendApk(req, res) {
  if (!fromHomeNetwork(req)) throw new HttpError(403, 'Only available on the home network');
  if (!fs.existsSync(APK_FILE)) throw new HttpError(404, 'No app build on the server yet');
  const st = fs.statSync(APK_FILE);
  res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="TiviSync.apk"' });
  await new Promise((resolve) => fs.createReadStream(APK_FILE).on('end', resolve).on('error', resolve).pipe(res));
  return undefined;
}
route('GET', '/tv', 'none', async (req, b, p, ctx, res) => sendApk(req, res));
route('GET', '/TiviSync.apk', 'none', async (req, b, p, ctx, res) => sendApk(req, res));

// --- devices ---
route('POST', '/api/admin/pairing-code', 'admin', async () => {
  db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(now());
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = now() + 10 * 60 * 1000;
  db.prepare('INSERT OR REPLACE INTO pairing_codes (code, expires_at) VALUES (?, ?)').run(code, expiresAt);
  return { code, expiresAt };
});
route('PATCH', '/api/admin/devices/:id', 'admin', async (req, b, { id }) => {
  if (b.name) db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(String(b.name).slice(0, 40), id);
  if (b.wgConfig !== undefined) db.prepare('UPDATE devices SET wg_config = ? WHERE id = ?').run(validateWg(b.wgConfig), id);
  return { ok: true };
});
route('DELETE', '/api/admin/devices/:id', 'admin', async (req, b, { id }) => {
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  return { ok: true };
});

// =====================================================================
// TV API – used by the Android TV app
// =====================================================================
route('POST', '/api/tv/pair', 'none', async (req, b) => {
  const ip = req.socket.remoteAddress;
  rateLimit('pair:' + ip, 10);
  const code = String(b.code || '').trim();
  const row = db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code);
  if (!row || row.expires_at < now()) throw new HttpError(401, 'Pairing code invalid or expired');
  db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code);
  const t = token();
  const name = String(b.name || 'TV').slice(0, 40);
  db.prepare('INSERT INTO devices (name, token, created_at, last_seen) VALUES (?, ?, ?, ?)').run(name, t, now(), now());
  clearAttempts('pair:' + ip);
  return { deviceToken: t, name };
});

// --- away-from-home address ---
// The add-on asks Home Assistant for its external address (Nabu Casa remote domain, or the configured
// external URL) and hands it to the TVs, so they keep up to date if it ever changes.
// Phones/TVs then reach the add-on through the TiviSync integration at <address>/api/tivisync.
let remote = { url: null, source: null, checkedAt: 0, error: null };

function haWs(messages) {
  // one short websocket session to Home Assistant via the Supervisor proxy
  return new Promise((resolve, reject) => {
    const token = process.env.SUPERVISOR_TOKEN;
    if (!token || typeof WebSocket === 'undefined') return reject(new Error('not running as a Home Assistant add-on'));
    const ws = new WebSocket('ws://supervisor/core/websocket');
    const out = {}; let id = 0;
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('Home Assistant did not answer')); }, 15000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('cannot reach Home Assistant')); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (m.type === 'auth_invalid') { clearTimeout(timer); ws.close(); reject(new Error('Home Assistant refused the add-on token')); }
      else if (m.type === 'auth_ok') messages.forEach((msg) => ws.send(JSON.stringify({ id: ++id, ...msg })));
      else if (m.type === 'result') {
        out[messages[m.id - 1].type] = m.success ? m.result : null;
        if (Object.keys(out).length === messages.length) { clearTimeout(timer); ws.close(); resolve(out); }
      }
    };
  });
}

// --- announcements: doorbell presses and messages from Home Assistant pause the TVs and are shown / read out ---
// Home Assistant side: the doorbell entity (add-on option doorbell_entity) is watched automatically, and any
// automation or script can send a message with the event  tivisync_announce  { message, title?, pause? }.
const announcements = []; // newest last
let annLast = 0;
const haLive = { connected: false, error: null, since: 0, doorbell: null };
function announce(kind, message, opts = {}) {
  const at = now();
  if (kind === 'doorbell' && at - annLast < 20_000 && announcements.some((a) => a.kind === 'doorbell' && at - a.at < 20_000)) return null; // one ring at a time
  annLast = at;
  const a = { id: `${at}-${Math.random().toString(36).slice(2, 7)}`, kind, at,
    title: String(opts.title || (kind === 'doorbell' ? "🔔 Someone's at the door" : '📢 Announcement')).slice(0, 80),
    message: String(message || '').slice(0, 300), pause: opts.pause !== false, speak: opts.speak !== false,
    profile: opts.profile != null && String(opts.profile).trim() ? String(opts.profile).trim().slice(0, 60) : null };
  announcements.push(a);
  while (announcements.length > 20 || (announcements[0] && at - announcements[0].at > 600_000)) announcements.shift();
  console.log(`Announcement (${kind}): ${a.title}${a.message ? ' – ' + a.message : ''}`);
  return a;
}
const ANNOUNCE_FRESH = 90_000;
// Newest announcement for this TV: ones for everyone, or ones aimed at the profile signed in on it (by id or name).
function currentAnnouncement(profile = null) {
  for (let i = announcements.length - 1; i >= 0; i--) {
    const a = announcements[i];
    if (now() - a.at > ANNOUNCE_FRESH) break;
    if (a.profile && !(profile && (a.profile === String(profile.id) || a.profile.toLowerCase() === String(profile.name || '').toLowerCase()))) continue;
    const { profile: _p, ...rest } = a;
    return { ...rest, ageMs: now() - a.at };
  }
  return null;
}
// Today's reminders for a profile (sent by Family Planner as tivisync_announce with daily: true). They pop up once,
// on that profile's first sign-in of the day; a later update the same day is kept but not shown again.
const dailyNotes = new Map(); // profile (id or name, lower case) -> { date, title, message }
function setDailyNote(profile, d) {
  const key = String(profile || '').trim().toLowerCase();
  if (!key) return;
  if (!String(d.message || '').trim()) { dailyNotes.delete(key); return; }
  dailyNotes.set(key, { date: String(d.date || today()), title: String(d.title || '📅 Today').slice(0, 80), message: String(d.message).slice(0, 500) });
}
function dailyFor(profile) {
  if (!profile) return null;
  const n = dailyNotes.get(String(profile.id)) || dailyNotes.get(String(profile.name || '').toLowerCase());
  const day = today();
  if (!n || n.date !== day) return null;
  const key = `daily_seen_${profile.id}`;
  if (getSetting(key) === day) return null;
  setSetting(key, day);
  return { id: `daily-${profile.id}-${day}`, kind: 'message', at: now(), title: n.title, message: n.message, pause: false, speak: false, ageMs: 0 };
}
function profileOnDevice(req, deviceId) {
  const pt = req.headers['x-profile-token'];
  const s = pt && db.prepare('SELECT profile_id FROM profile_sessions WHERE token = ? AND device_id = ?').get(pt, deviceId);
  return s ? db.prepare('SELECT id, name FROM profiles WHERE id = ?').get(s.profile_id) : null;
}
function startHaListener() {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token || typeof WebSocket === 'undefined') return;
  const doorbell = (process.env.DOORBELL_ENTITY || 'binary_sensor.doorbell_visitor').trim();
  haLive.doorbell = doorbell || null;
  let id = 0;
  const connect = () => {
    let ws;
    try { ws = new WebSocket('ws://supervisor/core/websocket'); } catch (e) { haLive.error = e.message; setTimeout(connect, 30_000); return; }
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (m.type === 'auth_invalid') { haLive.error = 'Home Assistant refused the add-on token'; ws.close(); }
      else if (m.type === 'auth_ok') {
        haLive.connected = true; haLive.error = null; haLive.since = now();
        ws.send(JSON.stringify({ id: ++id, type: 'subscribe_events', event_type: 'tivisync_announce' }));
        if (doorbell) ws.send(JSON.stringify({ id: ++id, type: 'subscribe_trigger', trigger: { platform: 'state', entity_id: doorbell, to: 'on' } }));
      } else if (m.type === 'result' && !m.success) {
        haLive.error = m.error?.message || 'subscription refused';
      } else if (m.type === 'event' && m.event) {
        const e = m.event;
        if (e.event_type === 'tivisync_announce') {
          const d = e.data || {};
          if (d.daily) { setDailyNote(d.profile, d); return; }
          announce(d.kind === 'doorbell' ? 'doorbell' : 'message', d.message, { title: d.title, pause: d.pause, speak: d.speak, profile: d.profile });
        } else if (e.variables?.trigger) {
          announce('doorbell', '');
        }
      }
    };
    ws.onclose = () => { haLive.connected = false; setTimeout(connect, 15_000); };
    ws.onerror = () => { haLive.error = haLive.error || 'cannot reach Home Assistant'; try { ws.close(); } catch { /* ignore */ } };
  };
  connect();
}
if (!process.env.NO_CHARTS) setTimeout(startHaListener, 3_000);
// Other Home Assistant add-ons (e.g. Family Planner) can list the profiles to link people to them.
// Only answered on Home Assistant's internal add-on network, never to the LAN or the internet.
route('GET', '/api/internal/profiles', 'none', async (req) => {
  const ra = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!/^172\.30\.3[23]\.\d+$/.test(ra) || ra === '172.30.32.1') throw new HttpError(403, 'Only available to Home Assistant add-ons');
  return db.prepare('SELECT id, name FROM profiles ORDER BY name').all();
});
route('GET', '/api/admin/announce', 'admin', async () => ({ ...haLive, latest: currentAnnouncement() }));
route('POST', '/api/admin/announce', 'admin', async (req, b) => {
  const kind = b.kind === 'doorbell' ? 'doorbell' : 'message';
  if (b.daily) { setDailyNote(b.profile, b); return { ok: true }; }
  if (kind === 'message' && !String(b.message || '').trim()) throw new HttpError(400, 'Type a message to send');
  return announce(kind, b.message, { title: b.title, pause: b.pause, profile: b.profile });
});

async function refreshRemoteUrl() {
  const fix = (u) => u.replace(/\/+$/, '') + '/api/tivisync';
  try {
    if (process.env.REMOTE_URL) { remote = { url: fix(process.env.REMOTE_URL), source: 'add-on option remote_url', checkedAt: now(), error: null }; return; }
    const r = await haWs([{ type: 'cloud/status' }, { type: 'get_config' }]);
    const cloud = r['cloud/status'];
    const ext = r.get_config?.external_url;
    if (cloud?.remote_domain && cloud?.prefs?.remote_enabled !== false) remote = { url: fix('https://' + cloud.remote_domain), source: 'Nabu Casa', checkedAt: now(), error: null };
    else if (ext) remote = { url: fix(ext), source: 'Home Assistant external URL', checkedAt: now(), error: null };
    else remote = { url: getSetting('remote_url'), source: getSetting('remote_url') ? 'last known' : null, checkedAt: now(), error: 'Home Assistant has no external address (turn on Remote access in Settings › Home Assistant Cloud)' };
    if (remote.url) setSetting('remote_url', remote.url);
  } catch (e) {
    remote = { url: getSetting('remote_url'), source: getSetting('remote_url') ? 'last known' : null, checkedAt: now(), error: e.message };
  }
}
if (!process.env.NO_CHARTS) { setTimeout(() => refreshRemoteUrl().catch(() => {}), 5_000); setInterval(() => refreshRemoteUrl().catch(() => {}), 6 * 3600_000); }
route('GET', '/api/admin/remote', 'admin', async () => remote);
route('POST', '/api/admin/remote/refresh', 'admin', async () => { await refreshRemoteUrl(); return remote; });

route('GET', '/api/tv/bootstrap', 'device', async (req, b, p, ctx) => ({
  remoteUrl: remote.url || getSetting('remote_url'),
  lanUrl: getSetting('lan_url'),
  device: { id: ctx.device.id, name: ctx.device.name },
  profiles: db.prepare('SELECT * FROM profiles ORDER BY id').all().map((x) => profileRow(x)),
  sources: db.prepare('SELECT * FROM sources ORDER BY id').all().map(sourceRow),
  vpn: {
    required: getSetting('vpn_required') === '1',
    dedicatedIp: getSetting('vpn_dedicated_ip'),
    wgConfig: ctx.device.wg_config || getSetting('vpn_default_config'),
    configSource: ctx.device.wg_config ? 'device' : getSetting('vpn_default_config') ? 'shared' : null,
    homeOnly: getSetting('vpn_home_only', '1') === '1',
  },
}));

route('POST', '/api/tv/profiles/:id/login', 'device', async (req, b, { id }, ctx) => {
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'Profile not found');
  const key = `pin:${ctx.device.id}:${id}`;
  rateLimit(key, 5);
  if (!checkPin(b.pin, p.pin_hash)) throw new HttpError(401, 'Wrong PIN');
  clearAttempts(key);
  const t = token();
  db.prepare('INSERT INTO profile_sessions (token, profile_id, device_id, created_at) VALUES (?,?,?,?)').run(t, p.id, ctx.device.id, now());
  return { profileToken: t, profile: profileRow(p), allowance: allowance(p.id) };
});

route('POST', '/api/tv/logout', 'profile', async (req) => {
  db.prepare('DELETE FROM profile_sessions WHERE token = ?').run(req.headers['x-profile-token']);
  return { ok: true };
});

// --- progress / continue watching ---
route('GET', '/api/tv/continue', 'profile', async (req, b, p, { profile }) => {
  const rows = db.prepare(`SELECT * FROM progress WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 300`).all(profile.id);
  const seenSeries = new Set();
  const continueWatching = [];
  const recentChannels = [];
  for (const r of rows) {
    const item = progressRow(r);
    if (r.type === 'live') { if (recentChannels.length < 20) recentChannels.push(item); continue; }
    if (r.type === 'episode') {
      // one card per series: the most recent episode. If it was finished, the TV offers the next episode.
      if (seenSeries.has(r.series_id)) continue;
      seenSeries.add(r.series_id);
      if (r.watched && now() - r.updated_at > 30 * 86400000) continue;
      if (continueWatching.length < 30) continueWatching.push(item);
      continue;
    }
    if (!r.watched && continueWatching.length < 30) continueWatching.push(item);
  }
  return { continueWatching, recentChannels };
});

route('GET', '/api/tv/progress', 'profile', async (req, b, p, { profile }) => {
  const u = new URL(req.url, 'http://x');
  const seriesId = u.searchParams.get('seriesId');
  const sourceId = u.searchParams.get('sourceId');
  const type = u.searchParams.get('type');
  let rows;
  if (seriesId) rows = db.prepare('SELECT * FROM progress WHERE profile_id=? AND series_id=? AND source_id=?').all(profile.id, seriesId, sourceId);
  else if (type) rows = db.prepare('SELECT * FROM progress WHERE profile_id=? AND type=? ORDER BY updated_at DESC LIMIT 2000').all(profile.id, type);
  else rows = db.prepare('SELECT * FROM progress WHERE profile_id=? ORDER BY updated_at DESC LIMIT 2000').all(profile.id);
  return rows.map(progressRow);
});

function progressRow(r) {
  return {
    key: r.item_key, type: r.type, sourceId: r.source_id, streamId: r.stream_id, seriesId: r.series_id,
    season: r.season, episode: r.episode, title: r.title, seriesTitle: r.series_title, poster: r.poster, url: r.url,
    positionMs: r.position_ms, durationMs: r.duration_ms, watched: !!r.watched, updatedAt: r.updated_at,
  };
}

route('PUT', '/api/tv/progress', 'profile', async (req, b, p, { profile, device }) => {
  if (!b.key || !b.type) throw new HttpError(400, 'key and type required');
  const pos = Math.max(0, Number(b.positionMs) | 0);
  const dur = Math.max(0, Number(b.durationMs) | 0);
  const watched = b.watched != null ? (b.watched ? 1 : 0) : (dur > 0 && pos / dur > 0.92 ? 1 : 0);
  db.prepare(`INSERT INTO progress (profile_id, item_key, type, source_id, stream_id, series_id, season, episode, title, series_title, poster, url,
      position_ms, duration_ms, watched, updated_at, device_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(profile_id, item_key) DO UPDATE SET
      type=excluded.type, source_id=excluded.source_id, stream_id=excluded.stream_id, series_id=excluded.series_id,
      season=excluded.season, episode=excluded.episode, title=excluded.title, series_title=excluded.series_title,
      poster=COALESCE(excluded.poster, progress.poster), url=excluded.url, position_ms=excluded.position_ms,
      duration_ms=CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE progress.duration_ms END,
      watched=excluded.watched, updated_at=excluded.updated_at, device_id=excluded.device_id`)
    .run(profile.id, String(b.key), String(b.type), b.sourceId ?? null, b.streamId != null ? String(b.streamId) : null,
      b.seriesId != null ? String(b.seriesId) : null, b.season ?? null, b.episode ?? null, b.title ?? null, b.seriesTitle ?? null,
      b.poster ?? null, b.url ?? null, pos, dur, watched, now(), device.id);
  return { ok: true, watched: !!watched };
});

route('DELETE', '/api/tv/progress', 'profile', async (req, b, p, { profile }) => {
  db.prepare('DELETE FROM progress WHERE profile_id = ? AND item_key = ?').run(profile.id, String(b.key || ''));
  return { ok: true };
});

// --- favourites ---
route('GET', '/api/tv/favorites', 'profile', async (req, b, p, { profile }) =>
  db.prepare('SELECT item_key, data FROM favorites WHERE profile_id = ? ORDER BY created_at').all(profile.id)
    .map((r) => ({ key: r.item_key, ...JSON.parse(r.data) })));
route('POST', '/api/tv/favorites', 'profile', async (req, b, p, { profile }) => {
  if (!b.key) throw new HttpError(400, 'key required');
  const { key, ...data } = b;
  db.prepare('INSERT OR REPLACE INTO favorites (profile_id, item_key, data, created_at) VALUES (?,?,?,?)').run(profile.id, String(key), JSON.stringify(data), now());
  return { ok: true };
});
route('DELETE', '/api/tv/favorites', 'profile', async (req, b, p, { profile }) => {
  db.prepare('DELETE FROM favorites WHERE profile_id = ? AND item_key = ?').run(profile.id, String(b.key || ''));
  return { ok: true };
});

// --- usage & time limits ---
route('GET', '/api/tv/allowance', 'profile', async (req, b, p, { profile }) => allowance(profile.id));

route('POST', '/api/tv/heartbeat', 'profile', async (req, b, p, { profile, device }) => {
  const seconds = Math.max(0, Math.min(120, Number(b.seconds) | 0)); // cap to avoid abuse / clock jumps
  const t = now();
  if (seconds > 0) {
    db.prepare(`INSERT INTO usage_daily (profile_id, day, seconds) VALUES (?, ?, ?)
      ON CONFLICT(profile_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`).run(profile.id, today(), seconds);
    // continue the current session if same device/profile/title within 3 minutes, else start new
    const last = db.prepare(`SELECT * FROM usage_sessions WHERE profile_id = ? AND device_id = ? ORDER BY id DESC LIMIT 1`).get(profile.id, device.id);
    if (last && last.title === (b.title ?? null) && t - last.last_at < 180_000) {
      db.prepare('UPDATE usage_sessions SET last_at = ?, seconds = seconds + ? WHERE id = ?').run(t, seconds, last.id);
    } else {
      db.prepare('INSERT INTO usage_sessions (profile_id, device_id, type, title, started_at, last_at, seconds) VALUES (?,?,?,?,?,?,?)')
        .run(profile.id, device.id, b.type ?? null, b.title ?? null, t - seconds * 1000, t, seconds);
    }
  }
  db.prepare('UPDATE devices SET now_profile_id = ?, now_title = ?, now_at = ? WHERE id = ?').run(profile.id, b.title ?? null, t, device.id);
  return allowance(profile.id);
});

route('POST', '/api/tv/time-request', 'profile', async (req, b, p, { profile, device }) => {
  const minutes = Math.max(5, Math.min(240, Math.round((Number(b.minutes) || 30) / 5) * 5));
  const al = allowance(profile.id);
  if (al.reason === 'hours' && !al.canAsk) throw new HttpError(400, `${al.message}. Extra time can't start TV time early.`);
  const existing = db.prepare("SELECT id FROM time_requests WHERE profile_id = ? AND status = 'pending'").get(profile.id);
  if (existing) return { id: existing.id, status: 'pending' };
  const r = db.prepare('INSERT INTO time_requests (profile_id, device_id, minutes, message, created_at) VALUES (?,?,?,?,?)')
    .run(profile.id, device.id, minutes, b.message ? String(b.message).slice(0, 200) : null, now());
  notify(`${profile.name} wants more TV time`, `${profile.name} is asking for ${minutes} more minutes on ${device.name}. Open the parent app to approve.`,
    { event: 'time_request', requestId: Number(r.lastInsertRowid), profileId: profile.id, profile: profile.name, minutes, device: device.name });
  return { id: Number(r.lastInsertRowid), status: 'pending' };
});

route('GET', '/api/tv/time-request/:id', 'profile', async (req, b, { id }, { profile }) => {
  const r = db.prepare('SELECT * FROM time_requests WHERE id = ? AND profile_id = ?').get(id, profile.id);
  if (!r) throw new HttpError(404, 'Not found');
  return { id: r.id, status: r.status, grantedMinutes: r.granted_minutes, allowance: allowance(profile.id) };
});

// --- "what's popular" charts (Netflix / Prime Video / Sky) ---
// Fetched here once every 6 h; each TV keeps only the titles that exist in its own IPTV library.
// Netflix: official weekly Top 10 for the region (TMDB as fallback). Prime Video + Sky: TMDB "where to watch" data,
// which needs a free TMDB API key (add-on option tmdb_api_key).
const TMDB_KEY = () => process.env.TMDB_API_KEY || '';
const CHART_REGION = () => (process.env.CHART_REGION || 'GB').toUpperCase();
const NETFLIX_TSV = 'https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
let charts = { updatedAt: 0, list: [], status: {} };

async function tmdb(p, params = {}) {
  const key = TMDB_KEY();
  if (!key) throw new Error('add a TMDB API key in the add-on Configuration');
  const u = new URL((process.env.TMDB_BASE || 'https://api.themoviedb.org/3') + p); // TMDB_BASE: tests only
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  if (key.length > 40) headers.Authorization = 'Bearer ' + key; else u.searchParams.set('api_key', key);
  const r = await fetch(u, { headers, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

async function tmdbDiscover(kind, providers, extra, pages) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const j = await tmdb(`/discover/${kind}`, { watch_region: CHART_REGION(), with_watch_providers: providers,
      with_watch_monetization_types: 'flatrate', language: 'en-GB', include_adult: 'false', page, ...extra });
    for (const x of j.results || []) {
      const date = x.release_date || x.first_air_date || '';
      out.push({ title: x.title || x.name, original: x.original_title || x.original_name || null,
        year: date ? Number(date.slice(0, 4)) : null, poster: x.poster_path ? TMDB_IMG + x.poster_path : null,
        rank: out.length + 1, released: date || null });
    }
    if (page >= (j.total_pages || 1)) break;
  }
  return out;
}

async function netflixTop10(category) {
  const r = await fetch(NETFLIX_TSV, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Netflix ${r.status}`);
  const lines = (await r.text()).split('\n');
  const head = lines[0].split('\t');
  const col = (n) => head.indexOf(n);
  const [ci, wk, cat, rk, st, se] = ['country_iso2', 'week', 'category', 'weekly_rank', 'show_title', 'season_title'].map(col);
  if (ci < 0 || st < 0) throw new Error('Netflix file format changed');
  const rows = [];
  for (const l of lines.slice(1)) {
    const f = l.split('\t');
    if (f[ci] === CHART_REGION() && f[cat] === category) rows.push(f);
  }
  const latest = rows.reduce((m, f) => (f[wk] > m ? f[wk] : m), '');
  return rows.filter((f) => f[wk] === latest).sort((a, b) => a[rk] - b[rk])
    .map((f, i) => ({ title: f[st], season: se >= 0 && f[se] && f[se] !== 'N/A' ? f[se] : null, year: null, poster: null,
      rank: Number(f[rk]) || i + 1, week: latest }));
}

async function refreshCharts() {
  const today = new Date().toISOString().slice(0, 10);
  const defs = [
    { id: 'netflix-tv', title: 'Top 10 TV shows on Netflix', kind: 'series', limit: 10,
      load: async () => { try { return await netflixTop10('TV'); } catch (e) {
        if (!TMDB_KEY()) throw e; return tmdbDiscover('tv', '8', { sort_by: 'popularity.desc' }, 3); } } },
    { id: 'prime-tv', title: 'Top 10 TV shows on Prime Video', kind: 'series', limit: 10,
      load: () => tmdbDiscover('tv', '9|119', { sort_by: 'popularity.desc' }, 3) },
    { id: 'sky-movies', title: 'Latest films on Sky', kind: 'movie', limit: 20,
      load: () => tmdbDiscover('movie', '29|39', { sort_by: 'primary_release_date.desc', 'primary_release_date.lte': today, 'vote_count.gte': 5 }, 4) },
  ];
  const list = []; const status = {};
  for (const d of defs) {
    try {
      const items = await d.load();
      if (items.length) list.push({ id: d.id, title: d.title, kind: d.kind, limit: d.limit, items });
      status[d.id] = { ok: true, count: items.length };
    } catch (e) {
      status[d.id] = { ok: false, error: e.message };
      const old = charts.list.find((c) => c.id === d.id); // keep the last good copy
      if (old) list.push(old);
    }
  }
  charts = { updatedAt: now(), list, status };
  console.log('Charts refreshed:', JSON.stringify(status));
}
if (!process.env.NO_CHARTS) { setTimeout(() => refreshCharts().catch(() => {}), 20_000); setInterval(() => refreshCharts().catch(() => {}), 6 * 3600_000); }

route('GET', '/api/tv/charts', 'device', async () => ({ updatedAt: charts.updatedAt, charts: charts.list }));
route('GET', '/api/admin/charts', 'admin', async () => ({ updatedAt: charts.updatedAt, status: charts.status, region: CHART_REGION(),
  tmdbKey: !!TMDB_KEY(), charts: charts.list.map((c) => ({ id: c.id, title: c.title, top: c.items.slice(0, 10).map((i) => i.title) })) }));
route('POST', '/api/admin/charts/refresh', 'admin', async () => { await refreshCharts(); return { ok: true, status: charts.status }; });

// --- age ratings for films & series ---
const ratings = require('./ratings');
let ratingRun = { running: false, at: 0, done: 0, error: null };

async function syncLibraries(force = false) {
  // adds every film / series in each source to title_ratings (as 'pending' until looked up)
  const ins = db.prepare(`INSERT INTO title_ratings (source_id, kind, ref, name, year, tmdb_id, status) VALUES (?,?,?,?,?,?,'pending')
    ON CONFLICT(source_id, kind, ref) DO UPDATE SET name = excluded.name, year = COALESCE(excluded.year, title_ratings.year),
      tmdb_id = COALESCE(excluded.tmdb_id, title_ratings.tmdb_id)`);
  for (const src of db.prepare('SELECT * FROM sources').all()) {
    let lib; try { lib = await ratings.libraryFor(src, { force, filesDir: FILES_DIR, hosted: HOSTED }); } catch (e) { ratingRun.error = `${src.name}: ${e.message}`; continue; }
    db.exec('BEGIN');
    try {
      for (const m of lib.movies) ins.run(src.id, 'movie', m.ref, m.name, m.year, m.tmdb);
      for (const sr of lib.series) ins.run(src.id, 'series', sr.ref, sr.name, sr.year, sr.tmdb);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    // titles flagged adult by the provider are 18 without asking TMDB
    for (const m of lib.movies) if (m.adult) db.prepare(`UPDATE title_ratings SET age = 18, cert = '18', status = 'rated', checked_at = ? WHERE source_id = ? AND kind = 'movie' AND ref = ? AND status != 'manual'`).run(now(), src.id, m.ref);
  }
}

/** Looks up pending titles on TMDB, a few at a time, until none are left. Titles not found are retried after 30 days. */
async function rateTitles() {
  if (ratingRun.running || !TMDB_KEY()) return;
  ratingRun = { running: true, at: now(), done: 0, error: null };
  try {
    await syncLibraries();
    const upd = db.prepare('UPDATE title_ratings SET tmdb_id = ?, cert = ?, country = ?, age = ?, status = ?, checked_at = ? WHERE source_id = ? AND kind = ? AND ref = ?');
    for (;;) {
      const batch = db.prepare(`SELECT * FROM title_ratings WHERE status = 'pending' OR (status IN ('none','error') AND checked_at < ?) LIMIT 40`).all(now() - 30 * 86400_000);
      if (!batch.length) break;
      await Promise.all([0, 1, 2, 3].map(async (w) => {
        for (let i = w; i < batch.length; i += 4) {
          const t = batch[i];
          try {
            const r = await ratings.lookup(tmdb, t.kind, { name: t.name, year: t.year, tmdb: t.tmdb_id });
            upd.run(r?.tmdbId ?? t.tmdb_id ?? null, r?.cert ?? null, r?.country ?? null, r?.age ?? null, r?.age != null ? 'rated' : 'none', now(), t.source_id, t.kind, t.ref);
          } catch (e) {
            if (/TMDB 429/.test(e.message)) await new Promise((res) => setTimeout(res, 5000));
            upd.run(t.tmdb_id ?? null, null, null, null, 'error', now(), t.source_id, t.kind, t.ref);
            ratingRun.error = e.message;
          }
          ratingRun.done++;
        }
      }));
    }
  } catch (e) { ratingRun.error = e.message; }
  ratingRun.running = false;
}
if (!process.env.NO_CHARTS) {
  setTimeout(() => rateTitles().catch(() => {}), 60_000).unref();
  setInterval(() => rateTitles().catch(() => {}), 30 * 60_000).unref(); // picks up new titles; the 3am job reloads libraries
}

route('GET', '/api/admin/ratings', 'admin', async (req) => {
  const sourceId = Number(new URL(req.url, 'http://x').searchParams.get('sourceId')) || null;
  const where = sourceId ? 'WHERE source_id = ?' : '';
  const args = sourceId ? [sourceId] : [];
  const counts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) n FROM title_ratings ${where} GROUP BY status`).all(...args).map((r) => [r.status, r.n]));
  const missing = db.prepare(`SELECT source_id, kind, ref, name, year FROM title_ratings ${where ? where + ' AND' : 'WHERE'} status IN ('none','error') ORDER BY kind, name LIMIT 500`).all(...args);
  const manual = db.prepare(`SELECT source_id, kind, ref, name, year, age FROM title_ratings ${where ? where + ' AND' : 'WHERE'} status = 'manual' ORDER BY name LIMIT 500`).all(...args);
  return { counts, running: ratingRun.running, done: ratingRun.done, error: ratingRun.error, tmdbKey: !!TMDB_KEY(),
    missing: missing.map((m) => ({ sourceId: m.source_id, kind: m.kind, ref: m.ref, name: m.name, year: m.year })),
    manual: manual.map((m) => ({ sourceId: m.source_id, kind: m.kind, ref: m.ref, name: m.name, year: m.year, age: m.age, label: ratings.AGE_LABEL(m.age) })) };
});
route('POST', '/api/admin/ratings/run', 'admin', async () => { rateTitles().catch(() => {}); return { started: true }; });
// set a rating by hand: { sourceId, kind, ref, age (0|8|12|15|18|null to look it up again) }
route('PUT', '/api/admin/ratings', 'admin', async (req, b) => {
  const age = b.age === null || b.age === '' ? null : Number(b.age);
  if (age !== null && ![0, 8, 12, 15, 18].includes(age)) throw new HttpError(400, 'Rating must be U, PG, 12, 15 or 18');
  const r = db.prepare(`UPDATE title_ratings SET age = ?, cert = ?, status = ?, checked_at = ? WHERE source_id = ? AND kind = ? AND ref = ?`)
    .run(age, age === null ? null : ratings.AGE_LABEL(age), age === null ? 'pending' : 'manual', now(), Number(b.sourceId), String(b.kind), String(b.ref));
  if (!r.changes) throw new HttpError(404, 'Title not found');
  return { ok: true };
});

// for the TV app: every known rating for this source + this profile's limit
route('GET', '/api/tv/ratings', 'profile', async (req, b, p, { profile }) => {
  const sourceId = Number(new URL(req.url, 'http://x').searchParams.get('sourceId'));
  const movies = {}, series = {};
  for (const r of db.prepare(`SELECT kind, ref, age FROM title_ratings WHERE source_id = ? AND age IS NOT NULL`).all(sourceId)) (r.kind === 'movie' ? movies : series)[r.ref] = r.age;
  return { maxAge: profile.max_age ?? null, hideUnrated: true, movies, series };
});

// --- channel manager: per-profile channel ticks + merged qualities ---
const chan = require('./channels');
const chanCfg = (id) => { try { return JSON.parse(getSetting('chan_cfg:' + id) || '{}'); } catch { return {}; } };
const saveChanCfg = (id, c) => setSetting('chan_cfg:' + id, JSON.stringify(c));
function sourceById(id) {
  const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(Number(id));
  if (!s) throw new HttpError(404, 'Source not found');
  return s;
}
const hiddenRefs = (profileId, sourceId) =>
  new Set(db.prepare('SELECT ref FROM channel_hidden WHERE profile_id = ? AND source_id = ?').all(profileId, sourceId).map((r) => r.ref));

// nightly refresh at 03:00 (server time zone) while the house is quiet: reloads every source's channel
// list, so new channels are picked up and merged with their other qualities automatically.
async function refreshAllChannels(reason = 'nightly') {
  for (const src of db.prepare('SELECT * FROM sources').all()) {
    const before = new Set((chan.cache.get(src.id)?.channels || []).map((c) => c.ref));
    const prev = (() => { try { return JSON.parse(getSetting('chan_last:' + src.id) || 'null'); } catch { return null; } })();
    const list = await chan.channelsFor(src, { force: true, filesDir: FILES_DIR, hosted: HOSTED }).catch((e) => ({ channels: [], error: e.message }));
    if (!list.channels.length) { setSetting('chan_last:' + src.id, JSON.stringify({ ...(prev || {}), at: now(), reason, error: list.error || 'empty list' })); continue; }
    const known = before.size ? before : new Set(prev?.refs || []);
    const added = known.size ? list.channels.filter((c) => !known.has(c.ref)).map((c) => c.name) : [];
    const groups = chan.buildGroups(list.channels, chanCfg(src.id));
    setSetting('chan_last:' + src.id, JSON.stringify({ at: now(), reason, total: list.channels.length, channels: groups.length,
      added: added.length, addedNames: added.slice(0, 20), removed: known.size ? [...known].filter((r) => !list.channels.some((c) => c.ref === r)).length : 0,
      refs: list.channels.map((c) => c.ref), error: list.error || null }));
    console.log(`Channels (${reason}) ${src.name}: ${list.channels.length} streams, ${groups.length} channels, ${added.length} new`);
  }
}
async function nightlyRatings() { await syncLibraries(true).catch(() => {}); await rateTitles().catch(() => {}); }
function scheduleNightly() {
  const next = new Date(); next.setHours(3, 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  setTimeout(async () => { await refreshAllChannels('nightly').catch((e) => console.warn('nightly channel refresh failed', e.message)); await nightlyRatings(); scheduleNightly(); }, next - Date.now()).unref();
}
if (!process.env.NO_CHARTS) { scheduleNightly(); setTimeout(() => refreshAllChannels('startup').catch(() => {}), 30_000).unref(); }

route('GET', '/api/admin/channels', 'admin', async (req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const src = sourceById(q.get('sourceId'));
  const profileId = Number(q.get('profileId')) || null;
  const list = await chan.channelsFor(src, { filesDir: FILES_DIR, hosted: HOSTED });
  const hidden = profileId ? hiddenRefs(profileId, src.id) : new Set();
  const groups = chan.buildGroups(list.channels, chanCfg(src.id))
    .map((g) => ({ ...g, hidden: g.members.every((m) => hidden.has(m.ref)) }));
  let last = null; try { const l = JSON.parse(getSetting('chan_last:' + src.id) || 'null'); if (l) { delete l.refs; last = l; } } catch { /* none yet */ }
  return { source: { id: src.id, name: src.name, type: src.type }, fetchedAt: list.at, error: list.error,
    categories: list.categories, total: list.channels.length, groups, last };
});

route('POST', '/api/admin/channels/reload', 'admin', async (req, b) => {
  sourceById(b.sourceId);
  await refreshAllChannels('manual');
  const l = JSON.parse(getSetting('chan_last:' + Number(b.sourceId)) || '{}');
  return { total: l.total || 0, added: l.added || 0, error: l.error || null };
});

// tick / untick: { sourceId, profileId (number or "all"), refs: [...], hidden: true|false }
route('PUT', '/api/admin/channels/visibility', 'admin', async (req, b) => {
  const src = sourceById(b.sourceId);
  const refs = Array.isArray(b.refs) ? b.refs.map(String).slice(0, 50000) : [];
  const profiles = b.profileId === 'all' ? db.prepare('SELECT id FROM profiles').all().map((r) => r.id) : [Number(b.profileId)];
  if (!profiles.length || profiles.some((id) => !db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(id))) throw new HttpError(404, 'Profile not found');
  const add = db.prepare('INSERT OR IGNORE INTO channel_hidden (profile_id, source_id, ref) VALUES (?, ?, ?)');
  const del = db.prepare('DELETE FROM channel_hidden WHERE profile_id = ? AND source_id = ? AND ref = ?');
  db.exec('BEGIN');
  try { for (const pid of profiles) for (const r of refs) (b.hidden ? add : del).run(pid, src.id, r); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, changed: refs.length * profiles.length };
});

// rename / default quality / split a group: { sourceId, key, name?, defaultRef?, split? }
route('PUT', '/api/admin/channels/group', 'admin', async (req, b) => {
  const src = sourceById(b.sourceId);
  const key = String(b.key || '');
  if (!key) throw new HttpError(400, 'key required');
  const cfg = chanCfg(src.id);
  cfg.names ||= {}; cfg.defaults ||= {}; cfg.split ||= []; cfg.merges ||= {};
  if (b.name !== undefined) { const n = String(b.name || '').trim().slice(0, 60); if (n) cfg.names[key] = n; else delete cfg.names[key]; }
  if (b.defaultRef !== undefined) cfg.defaults[key] = String(b.defaultRef);
  if (b.split === true) {
    if (key.startsWith('m:')) for (const r of Object.keys(cfg.merges)) { if (cfg.merges[r] === key) delete cfg.merges[r]; }
    else if (!cfg.split.includes(key)) cfg.split.push(key);
    delete cfg.names[key]; delete cfg.defaults[key];
  } else if (b.split === false) cfg.split = cfg.split.filter((k) => k !== key);
  saveChanCfg(src.id, cfg);
  return { ok: true };
});

// merge channels into one with quality choices: { sourceId, refs: [...], name }
route('POST', '/api/admin/channels/merge', 'admin', async (req, b) => {
  const src = sourceById(b.sourceId);
  const refs = Array.isArray(b.refs) ? [...new Set(b.refs.map(String))] : [];
  if (refs.length < 2) throw new HttpError(400, 'Pick at least two channels to merge');
  const cfg = chanCfg(src.id);
  cfg.merges ||= {}; cfg.names ||= {};
  const key = 'm:' + token().slice(0, 10);
  for (const r of refs) cfg.merges[r] = key;
  if (b.name) cfg.names[key] = String(b.name).trim().slice(0, 60);
  saveChanCfg(src.id, cfg);
  return { ok: true, key };
});

// what the TV app needs: channels hidden for this profile + merged channels with their qualities
route('GET', '/api/tv/channels/layout', 'profile', async (req, b, p, { profile }) => {
  const src = sourceById(new URL(req.url, 'http://x').searchParams.get('sourceId'));
  const hidden = [...hiddenRefs(profile.id, src.id)];
  const list = await chan.channelsFor(src, { filesDir: FILES_DIR, hosted: HOSTED });
  if (profile.max_age != null && profile.max_age < 18) { // age-limited profile: adult-looking channels go too
    const catName = Object.fromEntries(list.categories.map((c) => [c.id, c.name]));
    for (const ch of list.channels) if (ratings.isAdultChannel(ch.name, catName[ch.categoryId])) hidden.push(ch.ref);
  }
  const groups = chan.buildGroups(list.channels, chanCfg(src.id)).filter((g) => g.members.length > 1)
    .map((g) => ({ key: g.key, name: g.name, default: g.default, members: g.members.map((m) => ({ ref: m.ref, label: m.label })) }));
  return { hidden, groups };
});

// --- move playback to another TV ("handoff") ---
// The sending TV pauses, saves progress and posts the item here; the target TV polls and offers to continue.
const handoffs = new Map(); // targetDeviceId -> { ...item, profileId, fromName, at }
const HANDOFF_TTL = 10 * 60_000;

route('GET', '/api/tv/devices', 'device', async (req, b, p, ctx) =>
  db.prepare(`SELECT d.id, d.name, d.last_seen, d.now_title, d.now_at,
      (SELECT pr.name FROM profile_sessions s JOIN profiles pr ON pr.id = s.profile_id WHERE s.device_id = d.id ORDER BY s.created_at DESC LIMIT 1) AS profile_name
    FROM devices d WHERE d.id != ? ORDER BY d.name`).all(ctx.device.id).map((d) => ({
    id: d.id, name: d.name, online: now() - (d.last_seen || 0) < 90_000,
    nowPlaying: d.now_at && now() - d.now_at < 120_000 ? d.now_title : null,
    profileName: d.profile_name || null,
  })));

route('POST', '/api/tv/handoff', 'profile', async (req, b, p, { profile, device }) => {
  const to = db.prepare('SELECT id, name FROM devices WHERE id = ?').get(Number(b.toDeviceId));
  if (!to) throw new HttpError(404, 'TV not found');
  if (to.id === device.id) throw new HttpError(400, 'That is this TV');
  if (!b.url || !b.type) throw new HttpError(400, 'url and type required');
  const item = {};
  for (const k of ['type', 'url', 'title', 'sourceId', 'itemId', 'logo', 'seriesId', 'season', 'episode', 'seriesTitle', 'positionMs', 'durationMs'])
    if (b[k] !== undefined) item[k] = b[k];
  handoffs.set(to.id, { ...item, profileId: profile.id, profileName: profile.name, fromName: device.name, at: now() });
  return { ok: true, to: to.name };
});

// Polled by every TV every few seconds. Returns (and clears) a pending handoff. Because the sender was already
// signed in to that profile, the target TV is given a session for the same profile so it can resume straight away.
route('GET', '/api/tv/handoff', 'device', async (req, b, p, ctx) => {
  const signedIn = profileOnDevice(req, ctx.device.id);
  const announcement = currentAnnouncement(signedIn) || dailyFor(signedIn);
  const h = handoffs.get(ctx.device.id);
  if (!h) return { handoff: null, partyInvite: partyInviteFor(ctx.device.id), announcement };
  handoffs.delete(ctx.device.id);
  if (now() - h.at > HANDOFF_TTL) return { handoff: null, announcement };
  const prof = db.prepare('SELECT * FROM profiles WHERE id = ?').get(h.profileId);
  if (!prof) return { handoff: null, announcement };
  const t = token();
  db.prepare('INSERT INTO profile_sessions (token, profile_id, device_id, created_at) VALUES (?,?,?,?)').run(t, prof.id, ctx.device.id, now());
  return { handoff: h, profileToken: t, profile: profileRow(prof), allowance: allowance(prof.id), announcement };
});

// ---------- TV guide reminders (per profile, so they follow you to whichever TV you're on) ----------
const reminderRow = (r) => ({ id: r.id, sourceId: r.source_id, channelRef: r.channel_ref, channelName: r.channel_name,
  channelLogo: r.channel_logo, title: r.title, start: r.start, end: r.end });
route('GET', '/api/tv/reminders', 'profile', async (req, b, p, { profile }) => {
  db.prepare('DELETE FROM reminders WHERE end < ?').run(now() - 86_400_000);
  return db.prepare('SELECT * FROM reminders WHERE profile_id = ? AND end > ? ORDER BY start LIMIT 200').all(profile.id, now() - 300_000).map(reminderRow);
});
// --- diagnostic logs from the apps: stored 7 days, also echoed to the add-on log ---
const LOG_DAYS = 7;
route('POST', '/api/tv/logs', 'device', async (req, b, p, ctx) => {
  const entries = Array.isArray(b.entries) ? b.entries.slice(0, 500) : [];
  const meta = b.meta && typeof b.meta === 'object' ? b.meta : {};
  const ins = db.prepare('INSERT INTO device_logs (device_id, ts, level, tag, msg) VALUES (?,?,?,?,?)');
  const t0 = now();
  db.exec('BEGIN');
  try {
    if (meta && Object.keys(meta).length) ins.run(ctx.device.id, t0, 'I', 'device', Object.entries(meta).map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(' ').slice(0, 600));
    for (const e of entries) {
      const ts = Math.min(Number(e.t) || t0, t0 + 60_000);
      if (ts < t0 - LOG_DAYS * 86400_000) continue;
      const level = ['D', 'I', 'W', 'E'].includes(e.l) ? e.l : 'I';
      const tag = String(e.g || 'app').slice(0, 24);
      const msg = String(e.m ?? '').slice(0, 1000);
      ins.run(ctx.device.id, ts, level, tag, msg);
      console.log(`[app] ${ctx.device.name} ${new Date(ts).toISOString().slice(5, 19).replace('T', ' ')} ${level}/${tag}: ${msg}`);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, stored: entries.length };
});
route('GET', '/api/admin/logs', 'admin', async (req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const dev = Number(q.get('device')) || null;
  const days = Math.min(Math.max(Number(q.get('days')) || LOG_DAYS, 1), LOG_DAYS);
  const rows = db.prepare(`SELECT l.*, d.name FROM device_logs l LEFT JOIN devices d ON d.id = l.device_id
    WHERE l.ts >= ? ${dev ? 'AND l.device_id = ?' : ''} ORDER BY l.ts, l.id LIMIT 20000`).all(...(dev ? [now() - days * 86400_000, dev] : [now() - days * 86400_000]));
  return { count: rows.length, lines: rows.map((r) => `${new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19)} ${r.name || '#' + r.device_id} ${r.level}/${r.tag}: ${r.msg}`) };
});
function pruneLogs() { try { db.prepare('DELETE FROM device_logs WHERE ts < ?').run(now() - LOG_DAYS * 86400_000); } catch { /* ignore */ } }
pruneLogs();
setInterval(pruneLogs, 3600_000).unref();

route('POST', '/api/tv/reminders', 'profile', async (req, b, p, { profile }) => {
  const start = Number(b.start), end = Number(b.end) || Number(b.start) + 1800_000;
  if (!b.channelRef || !b.title || !start) throw new HttpError(400, 'channelRef, title and start required');
  if (end < now()) throw new HttpError(400, 'That programme has already finished');
  const n = db.prepare('SELECT COUNT(*) n FROM reminders WHERE profile_id = ?').get(profile.id).n;
  if (n >= 200) throw new HttpError(400, 'Too many reminders – remove some first');
  db.prepare(`INSERT INTO reminders (profile_id, source_id, channel_ref, channel_name, channel_logo, title, start, end, created_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id, source_id, channel_ref, start) DO UPDATE SET title = excluded.title, end = excluded.end`)
    .run(profile.id, Number(b.sourceId) || 0, String(b.channelRef), String(b.channelName || ''), b.channelLogo || null, String(b.title).slice(0, 200), start, end, now());
  return reminderRow(db.prepare('SELECT * FROM reminders WHERE profile_id = ? AND source_id = ? AND channel_ref = ? AND start = ?')
    .get(profile.id, Number(b.sourceId) || 0, String(b.channelRef), start));
});
route('DELETE', '/api/tv/reminders/:id', 'profile', async (req, b, { id }, { profile }) => {
  db.prepare('DELETE FROM reminders WHERE id = ? AND profile_id = ?').run(Number(id), profile.id);
  return { ok: true };
});

// ---------- watch party: several TVs play the same film in step ----------
// The host invites TVs, everyone joins and says they're ready, the host presses start. Play / pause / seek from
// any member is shared; each TV polls every second and corrects itself against the server clock.
const parties = new Map(); // id -> party
const PARTY_IDLE = 6 * 3600_000, INVITE_TTL = 30 * 60_000;
setInterval(() => { for (const [id, pt] of parties) if (now() - pt.updatedAt > PARTY_IDLE) parties.delete(id); }, 10 * 60_000).unref();

function partyView(pt, deviceId) {
  return {
    id: pt.id, isHost: pt.host.deviceId === deviceId, hostName: pt.host.profileName, hostDevice: pt.host.deviceName,
    title: pt.item.seriesTitle ? `${pt.item.seriesTitle} – ${pt.item.title}` : pt.item.title, poster: pt.item.logo || null,
    state: pt.state, positionMs: pt.positionMs, at: pt.at, serverNow: now(), lastAction: pt.lastAction || null,
    members: [{ deviceId: pt.host.deviceId, name: pt.host.deviceName, profileName: pt.host.profileName, status: 'host' },
      ...[...pt.members.values()].map((m) => ({ deviceId: m.deviceId, name: m.deviceName, profileName: m.profileName, status: m.status, note: m.note || null }))],
  };
}
function partyFor(id, deviceId) {
  const pt = parties.get(String(id));
  if (!pt) throw new HttpError(404, 'This watch party has finished');
  if (pt.host.deviceId !== deviceId && !pt.members.has(deviceId)) throw new HttpError(403, "You're not in this watch party");
  return pt;
}
function partyInviteFor(deviceId) {
  for (const pt of parties.values()) {
    const m = pt.members.get(deviceId);
    if (m && m.status === 'invited' && pt.state !== 'ended' && now() - pt.createdAt < INVITE_TTL)
      return { partyId: pt.id, hostName: pt.host.profileName, hostDevice: pt.host.deviceName, title: partyView(pt, deviceId).title, poster: pt.item.logo || null };
  }
  return null;
}
// is this film / series allowed for an age-limited profile? (same rules as the TV app: unrated = hidden)
function itemAllowed(profile, item) {
  if (profile.max_age == null) return true;
  const kind = item.type === 'movie' ? 'movie' : 'series';
  const src = db.prepare('SELECT type FROM sources WHERE id = ?').get(Number(item.sourceId));
  const ref = kind === 'movie' ? (src?.type === 'm3u' ? item.url : String(item.itemId)) : String(item.seriesId || '');
  const r = db.prepare('SELECT age FROM title_ratings WHERE source_id = ? AND kind = ? AND ref = ?').get(Number(item.sourceId), kind, ref);
  return r != null && r.age != null && r.age <= profile.max_age;
}

route('POST', '/api/tv/party', 'profile', async (req, b, p, { profile, device }) => {
  const it = b.item || {};
  if (!['movie', 'episode'].includes(it.type) || !it.url) throw new HttpError(400, 'Pick a film or episode to watch together');
  const ids = [...new Set((Array.isArray(b.deviceIds) ? b.deviceIds : []).map(Number))].filter((d) => d && d !== device.id);
  if (!ids.length) throw new HttpError(400, 'Choose at least one TV to invite');
  const item = {};
  for (const k of ['type', 'url', 'title', 'sourceId', 'itemId', 'logo', 'seriesId', 'seriesTitle', 'season', 'episode']) if (it[k] !== undefined) item[k] = it[k];
  // one party per host TV
  for (const [id, old] of parties) if (old.host.deviceId === device.id) { old.state = 'ended'; old.lastAction = 'The host started a new party'; old.updatedAt = now(); parties.delete(id); }
  const members = new Map();
  for (const id of ids) {
    const d = db.prepare(`SELECT d.id, d.name, (SELECT pr.name FROM profile_sessions s JOIN profiles pr ON pr.id = s.profile_id
      WHERE s.device_id = d.id ORDER BY s.created_at DESC LIMIT 1) AS profile_name FROM devices d WHERE d.id = ?`).get(id);
    if (d) members.set(d.id, { deviceId: d.id, deviceName: d.name, profileName: d.profile_name || null, status: 'invited' });
  }
  if (!members.size) throw new HttpError(404, 'Those TVs were not found');
  const pt = { id: token().slice(0, 12), host: { deviceId: device.id, deviceName: device.name, profileId: profile.id, profileName: profile.name },
    item, members, state: 'lobby', positionMs: 0, at: now(), createdAt: now(), updatedAt: now() };
  parties.set(pt.id, pt);
  return partyView(pt, device.id);
});

route('GET', '/api/tv/party/:id', 'device', async (req, b, { id }, ctx) => partyView(partyFor(id, ctx.device.id), ctx.device.id));

route('POST', '/api/tv/party/:id/join', 'profile', async (req, b, { id }, { profile, device }) => {
  const pt = partyFor(id, device.id);
  const m = pt.members.get(device.id);
  if (!m) throw new HttpError(400, "You're the host");
  if (pt.state === 'ended') throw new HttpError(410, 'This watch party has finished');
  pt.updatedAt = now();
  m.profileName = profile.name;
  if (b.accept === false) { m.status = 'declined'; return { ok: true }; }
  if (!itemAllowed(profile, pt.item)) {
    m.status = 'declined'; m.note = 'not allowed for this profile';
    throw new HttpError(403, `"${partyView(pt, device.id).title}" isn't allowed on ${profile.name}'s profile`);
  }
  m.status = 'joined'; m.note = null;
  return { party: partyView(pt, device.id), item: pt.item };
});

route('POST', '/api/tv/party/:id/ready', 'device', async (req, b, { id }, ctx) => {
  const pt = partyFor(id, ctx.device.id);
  const m = pt.members.get(ctx.device.id);
  if (m && ['joined', 'ready'].includes(m.status)) m.status = b.ready === false ? 'joined' : 'ready';
  pt.updatedAt = now();
  return partyView(pt, ctx.device.id);
});

route('POST', '/api/tv/party/:id/control', 'device', async (req, b, { id }, ctx) => {
  const pt = partyFor(id, ctx.device.id);
  const isHost = pt.host.deviceId === ctx.device.id;
  const m = pt.members.get(ctx.device.id);
  if (!isHost && !(m && ['joined', 'ready'].includes(m.status))) throw new HttpError(403, 'Join the party first');
  if (pt.state === 'ended') throw new HttpError(410, 'This watch party has finished');
  const who = isHost ? pt.host.profileName : (m.profileName || m.deviceName);
  const pos = Math.max(0, Number(b.positionMs) || 0);
  switch (b.action) {
    case 'start':
      if (!isHost) throw new HttpError(403, 'Only the host can start');
      pt.state = 'playing'; pt.positionMs = pos; pt.at = now() + 2500; pt.lastAction = `${who} started the film`; break;
    case 'play':
      if (pt.state === 'lobby') throw new HttpError(400, 'Waiting for the host to start');
      pt.state = 'playing'; pt.positionMs = pos; pt.at = now() + 800; pt.lastAction = `${who} pressed play`; break;
    case 'pause':
      if (pt.state === 'lobby') throw new HttpError(400, 'Waiting for the host to start');
      pt.state = 'paused'; pt.positionMs = pos; pt.at = now(); pt.lastAction = `${who} paused`; break;
    case 'seek':
      if (pt.state === 'lobby') throw new HttpError(400, 'Waiting for the host to start');
      pt.positionMs = pos; pt.at = now() + (pt.state === 'playing' ? 800 : 0); pt.lastAction = `${who} skipped`; break;
    default: throw new HttpError(400, 'Unknown action');
  }
  pt.updatedAt = now();
  return partyView(pt, ctx.device.id);
});

route('POST', '/api/tv/party/:id/leave', 'device', async (req, b, { id }, ctx) => {
  const pt = parties.get(String(id));
  if (!pt) return { ok: true };
  if (pt.host.deviceId === ctx.device.id) { pt.state = 'ended'; pt.lastAction = `${pt.host.profileName} ended the watch party`; }
  else { const m = pt.members.get(ctx.device.id); if (m) m.status = 'left'; }
  pt.updatedAt = now();
  return { ok: true };
});

route('GET', '/api/health', 'none', async () => ({ ok: true, time: now(), today: today() }));

// ---------- static files (parent web app) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(302, { Location: '/parent/' }); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- server ----------
// Remember the home-network address the TVs use (e.g. http://192.168.0.100:8080), so phones paired through
// Nabu Casa can still tell when they're at home – that's when the streaming VPN is needed.
let lanUrlCache = null;
function noteLanAddress(req) {
  const host = String(req.headers.host || '');
  if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}(:\d+)?$/.test(host) || !fromHomeNetwork(req)) return;
  const url = 'http://' + host;
  if (url === lanUrlCache) return;
  lanUrlCache = url;
  if (getSetting('lan_url') !== url) setSetting('lan_url', url);
}

const server = http.createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const pathname = new URL(req.url, 'http://x').pathname;
  noteLanAddress(req);
  if (!pathname.startsWith('/api/') && pathname !== '/tv' && pathname !== '/TiviSync.apk') return serveStatic(req, res);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const ctx = AUTH[r.auth](req);
      const body = !r.raw && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler(req, body, params, ctx, res);
      if (out === undefined) return; // handler streamed its own response
      return send(200, out);
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (res.headersSent) return res.end();
    send(e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
});

// housekeeping: expire old sessions & keep logs to 180 days
setInterval(() => {
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM usage_sessions WHERE started_at < ?').run(now() - 180 * 86400000);
}, 3600_000).unref();

server.listen(PORT, () => console.log(`TiviSync server listening on :${PORT} (TZ ${TZ})`));
