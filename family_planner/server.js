#!/usr/bin/env node
'use strict';
/* Family Planner server. No npm packages: needs only Node 18 or newer. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const PORT = +(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'rota.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SESSION_DAYS = 90;
const MAX_BODY = 64 * 1024;
const LOG_LIMIT = 5000;
const SHARED = ['rooms', 'chores', 'log', 'meta', 'schedules', 'holidays', 'work', 'away', 'events', 'trips', 'dinners', 'dinnerTasks'];
const CHECK_AFTER = 30 * 60 * 1000;
const CHECK_GRACE = 15 * 60 * 1000;
const SNOOZE = 3600 * 1000;
const REPORT_DAYS = 14;
const KEEP_PLANS_DAYS = 30;
const UPDATES_SHOWN = 4;
const STATS_DAYS = 14;
const PRIVATE = ['schedules', 'holidays', 'work', 'away', 'events', 'trips'];
const HOUSE_TZ = process.env.HOUSE_TZ || 'Europe/London';
const REMIND_FROM = '16:00';
const DELAY_MINUTES = 30;
const UPDATES_DIR = path.join(DATA_DIR, 'updates');
const UPDATER_DIR = process.env.UPDATER_DIR || '/var/lib/home-rota-update';
const SHIFT_MAX = 4 * 3600 * 1000;
const SHIFT_LIMIT = 3000;
const ACTIVITY_LIMIT = 5000;
const OPEN_GAP = 30 * 60 * 1000;
const OLD_TALK_DIR = path.join(DATA_DIR, 'talk');
const CHAT_DAYS = 14;
const CHAT_MAX = 1000;
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const MAX_PHOTO = 3 * 1024 * 1024;
const PHOTO_DAYS = 90;
const MAX_PACKAGE = 5 * 1024 * 1024;
const ADMIN_ONLY = 'Only a household admin can change that.';
const CHANGES = (() => { try { return (JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).changes || []).slice(0, 4); } catch { return []; } })();
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version; } catch { return '1.0.0'; } })();
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USER_RE = /^(?=.{3,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_ERROR = 'Enter a valid email address.';
const MIN_PASSWORD = 8;

/* ---------- storage: one JSON file, replaced atomically ---------- */
const empty = () => ({ rooms: {}, chores: {}, log: {}, meta: {}, schedules: {}, holidays: {}, work: {}, away: {}, events: {}, trips: {}, outings: {}, deviceAsks: {}, awayReasons: {}, reasonsSeeded: false, sick: {}, dinners: {}, dinnerTasks: {}, nights: {}, nightTypes: {}, nightGroups: [], nightSeeded: false, shop: {}, photos: {}, reviews: {}, push: {}, pushPrefs: {}, pushSent: {}, vapid: null, chat: {}, activity: [], shifts: {}, updates: [], lastBackup: null, members: {}, logins: {}, sessions: {}, haLinks: {}, speakSent: {}, tvSent: {}, dailySent: {} });
let db = empty();
let saveTimer = null;

function load() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(DB_FILE)) db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  /* Voice messages were replaced by chat, so anything left from them is removed. */
  fs.rmSync(OLD_TALK_DIR, { recursive: true, force: true });
  delete db.talk;
  delete db.shopToken;
  if (!db.reasonsSeeded) {
    db.awayReasons = { night: { name: 'Out for the night' }, evening: { name: 'Out for the evening' }, dad: { name: "At his dad's" } };
    db.reasonsSeeded = true;
  }
  if (!db.nightSeeded) {
    db.nightTypes = { movie: { name: 'Movie night', icon: '🎬' }, games: { name: 'Games night', icon: '🎲' }, drinks: { name: 'Drinks night', icon: '🍹' }, bbq: { name: 'BBQ', icon: '🍖' }, family: { name: 'Family over', icon: '👪' }, friends: { name: 'Friends over', icon: '👫' } };
    db.nightSeeded = true;
  }
  fs.mkdirSync(PHOTO_DIR, { recursive: true, mode: 0o700 });
  /* Home reminders used to be chores. They're reminders now, on the same dates. */
  for (const [id, c] of Object.entries(db.chores)) if (c.kind === 'reminder') {
    db.events[id] = { title: c.title, date: c.due || new Date().toISOString().slice(0, 10), time: c.time || '', unit: c.unit === 'day' ? 'day' : c.unit || 'once', every: c.every || 1, notes: c.notes || '', people: c.assignee ? [c.assignee] : [], createdBy: '' };
    delete db.chores[id];
  }
  /* Clocking in has gone, so anything left running stops here. The old sessions stay in the logs. */
  for (const s of Object.values(db.shifts)) if (!s.end) { s.end = Date.now(); delete s.checkAt; }
  /* Accounts from before the tick boxes: admins stay admins, and everyone else becomes a cleaner. */
  for (const l of Object.values(db.logins)) {
    if (l.cleaner === undefined) l.cleaner = !l.admin;
    if (l.system === undefined) l.system = false;
  }
}
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  fs.writeSync(fd, JSON.stringify(db));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, DB_FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 150); }
function backup() {
  if (!fs.existsSync(DB_FILE)) return;
  const name = `rota-${new Date().toISOString().slice(0, 10)}.json`;
  const target = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(target)) fs.copyFileSync(DB_FILE, target);
  fs.chmodSync(target, 0o600);
  const files = fs.readdirSync(BACKUP_DIR).filter(f => /^rota-.*\.json$/.test(f)).sort();
  for (const f of files.slice(0, -14)) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

/* ---------- passwords and sessions ---------- */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString('hex') };
}
function checkPassword(password, login) {
  const { hash } = hashPassword(password, login.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(login.hash, 'hex'));
}
const tokenKey = t => crypto.createHash('sha256').update(t).digest('hex');
const DUMMY_LOGIN = hashPassword(crypto.randomBytes(16).toString('hex'));

function newSession(memberId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[tokenKey(token)] = { memberId, expires: Date.now() + SESSION_DAYS * 864e5 };
  save();
  return token;
}
function pruneSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (s.expires < now || !db.logins[s.memberId]) delete db.sessions[k];
}
function dropSessions(memberId, exceptKey) {
  for (const [k, s] of Object.entries(db.sessions)) if (s.memberId === memberId && k !== exceptKey) delete db.sessions[k];
}

/* Failed sign-ins: 5 tries per person per address, and 30 per address, then a 15-minute wait. */
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
function tooMany(keys) {
  const now = Date.now();
  return keys.some(([k, max]) => { const f = fails.get(k); return f && now - f.first < WINDOW && f.count >= max; });
}
function noteFail(keys) {
  const now = Date.now();
  for (const [k] of keys) { const f = fails.get(k); if (!f || now - f.first >= WINDOW) fails.set(k, { first: now, count: 1 }); else f.count++; }
}
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (now - f.first >= WINDOW) fails.delete(k); }, WINDOW).unref();

/* ---------- http helpers ---------- */
const isLocalPeer = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || process.env.TRUST_PROXY === '1';
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd && isLocalPeer(req)) return String(fwd).split(',').pop().trim();
  return req.socket.remoteAddress || 'unknown';
}
const isHttps = req => req.socket.encrypted || (isLocalPeer(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
function sessionCookie(req, value, maxAge) {
  return `rota_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const fail = (res, status, error) => send(res, status, { error });
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; resolve(v); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
/* Someone with both boxes ticked works as one or the other at a time. */
function activeRoles(l) {
  if (l.admin && l.cleaner) return l.mode === 'admin' ? { admin: true, cleaner: false } : { admin: false, cleaner: true };
  return { admin: !!l.admin, cleaner: !!l.cleaner };
}
function note(type, memberId, detail) {
  db.activity.push({ at: Date.now(), type, memberId, name: db.members[memberId]?.name || '', ...(detail ? { detail } : {}) });
  if (db.activity.length > ACTIVITY_LIMIT + 200) db.activity = db.activity.slice(-ACTIVITY_LIMIT);
  save();
}
function noteOpen(memberId) {
  for (let i = db.activity.length - 1; i >= 0; i--) {
    const a = db.activity[i];
    if (Date.now() - a.at > OPEN_GAP) break;
    if (a.memberId === memberId && (a.type === 'open' || a.type === 'signin')) return;
  }
  note('open', memberId);
}
/* ---------- Home Assistant sign-in ----------
 * Opened from the Home Assistant sidebar, every request comes from the Supervisor's ingress proxy with the
 * signed-in Home Assistant user in X-Remote-User-* headers. Those headers are only trusted from that proxy.
 * A Home Assistant user is linked to a Family Planner account by matching name, or by signing in once. */
const INGRESS_PEERS = ['172.30.32.2', '::ffff:172.30.32.2'];
function haUser(req) {
  if (!INGRESS_PEERS.includes(req.socket.remoteAddress)) return null;
  const id = String(req.headers['x-remote-user-id'] || '').trim();
  if (!/^[A-Za-z0-9]{8,64}$/.test(id)) return null;
  const name = String(req.headers['x-remote-user-display-name'] || req.headers['x-remote-user-name'] || '').trim();
  return { id, name };
}
function haMember(ha) {
  const linked = db.haLinks[ha.id];
  if (linked && db.logins[linked] && db.members[linked]) return linked;
  const want = ha.name.toLowerCase();
  if (!want) return null;
  const same = Object.keys(db.logins).filter(id => (db.members[id]?.name || '').trim().toLowerCase() === want);
  if (same.length !== 1) return null;
  db.haLinks[ha.id] = same[0]; save();
  console.log(`Home Assistant user "${ha.name}" linked to ${db.logins[same[0]].username} by name`);
  return same[0];
}
/* Signs the request in as the linked account, replacing any other session cookie. */
function haSignIn(req, res) {
  const ha = haUser(req);
  if (!ha) return;
  const memberId = haMember(ha);
  if (!memberId) return;
  const now = currentUser(req);
  if (now && now.id === memberId) return;
  const token = newSession(memberId);
  note('signin', memberId);
  req.headers.cookie = `rota_session=${token}`;
  res.setHeader('Set-Cookie', sessionCookie(req, token, SESSION_DAYS * 86400));
}

function currentUser(req) {
  const m = /(?:^|;\s*)rota_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const key = tokenKey(m[1]), s = db.sessions[key];
  if (!s || s.expires < Date.now() || !db.logins[s.memberId] || !db.members[s.memberId]) return null;
  const l = db.logins[s.memberId], roles = activeRoles(l);
  return { id: s.memberId, key, admin: roles.admin, cleaner: roles.cleaner, system: !!l.system, canSwitch: !!l.admin && !!l.cleaner, mode: l.mode === 'admin' ? 'admin' : 'cleaner', name: db.members[s.memberId].name, username: l.username };
}
const adminCount = () => Object.values(db.logins).filter(l => l.admin).length;
const systemCount = () => Object.values(db.logins).filter(l => l.system).length;
const openShift = memberId => { const e = Object.entries(db.shifts).find(([, s]) => s.memberId === memberId && !s.end); return e ? { id: e[0], ...e[1] } : null; };
/* Anyone working as a cleaner only gets the chores while they're clocked in. */
const findByUsername = u => Object.entries(db.logins).find(([, l]) => l.username === u);
const cleanName = v => typeof v === 'string' ? v.trim().slice(0, 60) : '';
const docId = () => crypto.randomBytes(9).toString('base64url').replace(/^[-_]/, 'm');

/* ---------- live updates ---------- */
const streams = new Set();
/* Non-admins see their own chores, chores they're covering, and ones for anyone or everyone. */
function choreVisibleTo(id, c) {
  const e = choreNow(c, houseClock().date);
  if (c.people && c.people.length) return c.people.includes(id);
  if (c.anyLevel && !e.who) return levelIds(c.anyLevel).includes(id);
  return !!c.everyone || !e.who || e.who === id || c.assignee === id;
}
const logVisibleTo = (id, l) => l.by === id || l.actor === id;
const seesAll = id => !!db.logins[id] && activeRoles(db.logins[id]).admin;
function mayReceive(memberId, event) {
  if (event.coll === 'chores' || event.coll === 'log') {
    if (event.coll === 'log' && event.doc && !seesAll(memberId)) return logVisibleTo(memberId, event.doc);
    return true;
  }
  if (event.coll === 'reviews') return seesAll(memberId);
  if (event.coll === 'shifts') return (db.logins[memberId] && activeRoles(db.logins[memberId]).admin) || event.owner === memberId;
  return true;
}
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of streams) {
    const session = db.sessions[c.key];
    if (!session) { c.res.end(); streams.delete(c); }
    else if (mayReceive(session.memberId, event)) {
      /* A chore that has moved to someone else disappears from this person's list. */
      const hide = event.coll === 'chores' && event.doc && !seesAll(session.memberId) && !choreVisibleTo(session.memberId, event.doc);
      c.res.write(hide ? `data: ${JSON.stringify({ coll: 'chores', id: event.id, doc: null })}\n\n` : line);
    }
  }
}
const GROUPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const groupOf = l => { const n = Math.round(+(l && l.level)); return GROUPS.includes(n) ? n : 1; };
/* Accounts from before tick boxes have one group, stored as their level. */
const groupsOf = l => Array.isArray(l && l.groups) ? l.groups : [groupOf(l)];
const cleanGroups = body => Array.isArray(body.groups) ? [...new Set(body.groups.map(Number).filter(n => GROUPS.includes(n)))].sort((a, b) => a - b) : [groupOf(body)];
const publicLogin = l => ({ username: l.username, admin: !!l.admin, cleaner: !!l.cleaner, system: !!l.system, level: groupsOf(l)[0] || 1, groups: groupsOf(l), dob: l.dob || '', tivisync: l.tivisync || '' });
const levelIds = level => Object.entries(db.logins).filter(([id, l]) => l.cleaner && groupsOf(l).includes(level) && db.members[id]).map(([id]) => id).sort((a, b) => (db.members[a].name || '').localeCompare(db.members[b].name || ''));
/* When someone leaves a group, their turn on that group's chores passes to the next person. */
function refillLevels() {
  for (const [id, c] of Object.entries(db.chores)) {
    if (!c.level) continue;
    const ids = levelIds(c.level);
    if (ids.includes(c.assignee) || (!ids.length && !c.assignee)) continue;
    c.assignee = ids[0] || '';
    broadcast({ coll: 'chores', id, doc: c });
  }
}
function publicLogins(user) {
  if (!user.admin) return { [user.id]: publicLogin(db.logins[user.id]) };
  return Object.fromEntries(Object.entries(db.logins).map(([id, l]) => [id, publicLogin(l)]));
}
function stateFor(user) {
  /* The private half of the notification key stays on the server. */
  const log = Object.entries(db.log).sort((a, b) => (b[1].stamp || 0) - (a[1].stamp || 0)).slice(0, 1000);
  const hidden = false;
  const titles = {};
  for (const l of Object.values(db.log)) if (l.shiftId && !l.rejected) (titles[l.shiftId] = titles[l.shiftId] || []).push(l.title);
  const shifts = Object.entries(db.shifts).filter(([, s]) => user.admin || s.memberId === user.id).map(([id, s]) => [id, { ...s, done: titles[id] || [] }]);
  return { rooms: db.rooms, chores: hidden ? {} : user.admin ? db.chores : Object.fromEntries(Object.entries(db.chores).filter(([, c]) => choreVisibleTo(user.id, c))), members: db.members, meta: db.meta, schedules: user.admin ? db.schedules : (db.schedules[user.id] ? { [user.id]: db.schedules[user.id] } : {}), holidays: user.admin ? db.holidays : holidaysFor(user.id), work: user.admin ? db.work : Object.fromEntries(Object.entries(db.work).filter(([, w]) => w.memberId === user.id)), away: user.admin ? db.away : Object.fromEntries(Object.entries(db.away).filter(([, a]) => a.memberId === user.id || a.coverId === user.id)), chat: db.chat, shop: db.shop, lastDone: lastDoneFor(user), outings: user.admin ? db.outings : Object.fromEntries(Object.entries(db.outings).filter(([, o]) => o.memberId === user.id)), deviceAsks: user.admin ? db.deviceAsks : Object.fromEntries(Object.entries(db.deviceAsks).filter(([, q]) => q.memberId === user.id)), awayReasons: db.awayReasons, sick: user.admin ? db.sick : (db.sick[user.id] ? { [user.id]: db.sick[user.id] } : {}), dinners: db.dinners, dinnerTasks: db.dinnerTasks, nights: db.nights, nightTypes: db.nightTypes, nightGroups: db.nightGroups, trips: db.trips, reviews: user.admin ? db.reviews : {}, events: user.admin ? db.events : eventsFor(user.id), shifts: Object.fromEntries(shifts), log: hidden ? {} : Object.fromEntries(user.admin ? log : log.filter(([, l]) => logVisibleTo(user.id, l))), me: { id: user.id, name: user.name, username: user.username, admin: user.admin, cleaner: user.cleaner, system: user.system, canSwitch: user.canSwitch, mode: user.mode }, logins: publicLogins(user), withSignIn: Object.keys(db.logins), changes: CHANGES, levels: Object.fromEntries(GROUPS.map(n => [n, levelIds(n)])), everyoneIds: Object.entries(db.logins).filter(([id, l]) => l.cleaner && !isOff(id, houseClock().date)).map(([id]) => id), birthdays: birthdaysFor(user), version: VERSION };
}
/* People only see their own school times and holidays, and never who else a holiday is for. */
function holidaysFor(id) {
  return Object.fromEntries(Object.entries(db.holidays).filter(([, h]) => !(h.people || []).length || h.people.includes(id)).map(([hid, h]) => [hid, { name: h.name, from: h.from, to: h.to, people: [] }]));
}
/* Admins know everyone's birthdays. Others only see their own, and a birthday today in their group because they may be covering it. */
function birthdaysFor(user) {
  const today = houseClock().date, out = {}, mine = groupsOf(db.logins[user.id]);
  for (const [id, l] of Object.entries(db.logins)) {
    if (!l.dob) continue;
    if (user.admin || id === user.id || (l.cleaner && groupsOf(l).some(n => mine.includes(n)) && isBirthday(id, today))) out[id] = l.dob.slice(5);
  }
  return out;
}
function pruneLog() {
  const entries = Object.entries(db.log);
  if (entries.length <= LOG_LIMIT) return;
  entries.sort((a, b) => (a[1].stamp || 0) - (b[1].stamp || 0));
  for (const [id] of entries.slice(0, entries.length - LOG_LIMIT)) delete db.log[id];
}

/* A session nobody confirms closes itself and is marked for an admin to check. */
function closeLongShifts() {
  const now = Date.now(); let changed = false;
  for (const s of Object.values(db.shifts)) {
    if (s.end) continue;
    /* Nobody answered "Are you still cleaning?", so the time stops when the question was asked. */
    if (s.checkAt && now >= s.checkAt + CHECK_GRACE) { s.end = s.checkAt; s.auto = true; note('auto-out', s.memberId); changed = true; }
    else if (now - s.start >= SHIFT_MAX && !s.checkAt) { s.end = s.start + SHIFT_MAX; s.auto = true; changed = true; }
  }
  if (changed) { save(); broadcast({ coll: 'logins' }); }
}
function pruneShifts() {
  const entries = Object.entries(db.shifts);
  if (entries.length <= SHIFT_LIMIT) return;
  entries.sort((a, b) => a[1].start - b[1].start);
  for (const [id, s] of entries.slice(0, entries.length - SHIFT_LIMIT)) if (s.end) delete db.shifts[id];
}
/* Cleaners can tick off, undo or put off a chore, but only admins can set what the chore is. */
function cleanerMayUpdateChore(old, next) {
  if (!old) return false;
  const free = new Set(['due', 'sched', 'lastDone', 'done', 'doneBy']);
  if (next.returned === undefined) free.add('returned');
  if (next.delay === undefined) free.add('delay');
  if (old.rotate) free.add('assignee');
  for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (k === 'once' && (next.once === undefined || next.once.assignee === old.once?.assignee)) continue;
    if (!free.has(k) && JSON.stringify(old[k]) !== JSON.stringify(next[k])) return false;
  }
  return true;
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/, DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanSchedule(doc) {
  const days = {};
  for (const d of ['1', '2', '3', '4', '5', '6', '7']) {
    const t = doc.days && doc.days[d]; if (!t) continue;
    if (!TIME_RE.test(t.start) || !TIME_RE.test(t.end) || t.start >= t.end) return null;
    days[d] = { start: t.start, end: t.end };
  }
  return { place: String(doc.place || 'School').trim().slice(0, 40) || 'School', days };
}
/* A finish time at or before the start time means the shift ends the next day. */
function cleanWork(doc) {
  if (!DATE_RE.test(doc.date) || !TIME_RE.test(doc.start) || !TIME_RE.test(doc.end) || doc.start === doc.end) return null;
  return { memberId: String(doc.memberId || ''), date: doc.date, start: doc.start, end: doc.end, note: String(doc.note || '').trim().slice(0, 80) };
}
function cleanAway(doc) {
  const memberId = String(doc.memberId || ''), coverId = String(doc.coverId || '');
  if (!db.members[memberId] || !DATE_RE.test(doc.from) || !DATE_RE.test(doc.to) || doc.from > doc.to) return null;
  if (coverId && (coverId === memberId || !db.members[coverId])) return null;
  const allDay = doc.allDay !== false;
  if (!allDay && (!TIME_RE.test(doc.leave) || !TIME_RE.test(doc.back))) return null;
  const text = String(doc.reason || '').trim().slice(0, 40);
  const known = Object.entries(db.awayReasons).find(([k, r]) => k === doc.reasonId || (text && r.name.toLowerCase() === text.toLowerCase()));
  return { memberId, from: doc.from, to: doc.to, coverId, allDay, ...(allDay ? {} : { leave: doc.leave, back: doc.back }), ...(known ? { reasonId: known[0], reason: known[1].name } : text ? { reason: text } : {}) };
}
function cleanEvent(doc, user, old) {
  const title = String(doc.title || '').trim().slice(0, 120), unit = ['once', 'day', 'week', 'month', 'year'].includes(doc.unit) ? doc.unit : 'once';
  if (!title || !DATE_RE.test(doc.date) || (doc.time && !TIME_RE.test(doc.time))) return null;
  const people = user.admin ? (Array.isArray(doc.people) ? doc.people.filter(id => db.members[id]) : []) : [user.id];
  return { title, date: doc.date, time: doc.time || '', unit, every: Math.max(1, Math.min(99, +doc.every || 1)), notes: String(doc.notes || '').trim().slice(0, 500), people, createdBy: old?.createdBy ?? user.id };
}
const eventsFor = id => Object.fromEntries(Object.entries(db.events).filter(([, e]) => !(e.people || []).length || e.people.includes(id) || e.createdBy === id));
function pruneEvents() {
  const cutoff = new Date(Date.now() - KEEP_PLANS_DAYS * 864e5).toISOString().slice(0, 10);
  for (const [id, e] of Object.entries(db.events)) if (e.unit === 'once' && e.date < cutoff) delete db.events[id];
  pruneAsks();
  for (const [id, o] of Object.entries(db.outings)) if (!o.weekly && o.to < cutoff) delete db.outings[id];
  for (const date of Object.keys(db.dinners)) if (date < cutoff) delete db.dinners[date];
  for (const [id, t] of Object.entries(db.dinnerTasks)) if (t.dinner < cutoff) delete db.dinnerTasks[id];
  for (const [id, n] of Object.entries(db.nights)) if (n.date < cutoff) delete db.nights[id];
}
function cleanHoliday(doc) {
  const name = String(doc.name || '').trim().slice(0, 60);
  if (!name || !DATE_RE.test(doc.from) || !DATE_RE.test(doc.to) || doc.from > doc.to) return null;
  return { name, from: doc.from, to: doc.to, people: Array.isArray(doc.people) ? doc.people.filter(id => db.members[id]) : [] };
}

/* ---------- phone notifications (Web Push, with no extra packages) ---------- */
const b64u = b => Buffer.from(b).toString('base64url');
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const PUSH_SUBJECT = process.env.PUSH_SUBJECT || 'https://hometask.eventfirstresponders.co.uk';
function allowedEndpoint(endpoint) {
  let u; try { u = new URL(String(endpoint)); } catch { return false; }
  if (process.env.ROTA_PUSH_TEST_ORIGIN && u.origin === process.env.ROTA_PUSH_TEST_ORIGIN) return true;
  return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some(h => h.test(u.hostname));
}
function vapidKeys() {
  if (!db.vapid) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    db.vapid = { publicJwk: publicKey.export({ format: 'jwk' }), privateJwk: privateKey.export({ format: 'jwk' }) };
    save();
  }
  return db.vapid;
}
const vapidPublic = () => { const j = vapidKeys().publicJwk; return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')])); };
function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 3600, sub: PUSH_SUBJECT }))}`;
  const key = crypto.createPrivateKey({ key: vapidKeys().privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapidPublic()}`;
}
/* RFC 8291: the message can only be read by the device it is for. */
function encryptPush(sub, text) {
  const clientPublic = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'), serverPublic = ecdh.generateKeys(), secret = ecdh.computeSecret(clientPublic), salt = crypto.randomBytes(16);
  const hkdf = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hkdf(secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, serverPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([serverPublic.length]), serverPublic, body]);
}
async function deliver(memberId, sub, payload) {
  try {
    const res = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidHeader(sub.endpoint) }, body: encryptPush(sub, JSON.stringify(payload)), signal: AbortSignal.timeout(10000) });
    /* The device has switched notifications off, so stop sending to it. */
    if (res.status === 404 || res.status === 410) { db.push[memberId] = (db.push[memberId] || []).filter(s => s.endpoint !== sub.endpoint); save(); }
    const host = new URL(sub.endpoint).hostname;
    if (!res.ok) { const why = (await res.text().catch(() => '')).slice(0, 200); console.error(`Notification refused: ${res.status} from ${host}: ${why}`); return { host, ok: false, status: res.status, why }; }
    return { host, ok: true, status: res.status };
  } catch (e) { console.error(`Notification failed: ${e.cause?.code || e.message}`); return { host: new URL(sub.endpoint).hostname, ok: false, status: 0, why: e.cause?.code || e.message }; }
}
const pushPrefs = id => ({ chat: true, chores: true, clock: true, ...db.pushPrefs[id] });
/* Nothing is sent during school or college times, work shifts or nights away. */
function notify(memberId, kind, payload, force) {
  const subs = db.push[memberId]; if (!subs || !subs.length) return;
  if (!force) {
    if (!pushPrefs(memberId)[kind]) return;
    if (isBusy(memberId, houseClock())) return;
  }
  for (const sub of subs) deliver(memberId, sub, payload);
}
/* Chores: at most one message for each chore a day, and none overnight. */
function pushChoreReminders() {
  const clock = houseClock();
  if (clock.time < '08:00' || clock.time >= '21:00') return;
  for (const id of Object.keys(db.push)) {
    const l = db.logins[id];
    if (!l || !db.members[id] || !(db.push[id] || []).length || isBusy(id, clock)) continue;
    const r = remindersFor({ id, ...activeRoles(l) });
    if (db.pushSent[id]?.date !== clock.date) db.pushSent[id] = { date: clock.date, ids: [] };
    const fresh = r.ids.filter(c => !db.pushSent[id].ids.includes(c));
    if (!fresh.length) continue;
    db.pushSent[id].ids.push(...fresh);
    const n = r.late + r.today;
    notify(id, 'chores', { title: 'Chores not done', body: `You have ${n} ${n === 1 ? 'chore' : 'chores'} to do.${r.late ? ` ${r.late} ${r.late === 1 ? 'is' : 'are'} late.` : ''}`, url: '/#today', tag: 'chores' });
    save();
  }
}

/* Unticks a chore, puts it back where it was scheduled and tells everyone in chat. */
function sendBack(user, logId, l, c, noteText, photo, needPhoto) {
  const returned = { note: noteText, photo, by: user.name, at: Date.now(), ...(needPhoto ? { needPhoto: true } : {}) };
  l.rejected = returned;
  creditTv(l, -1, 'sent back');
  if (photo) { db.photos[photo].choreId = l.choreId; db.photos[photo].public = true; }
  Object.assign(c, { due: l.prevDue, done: false, assignee: l.prevAssignee || '', returned });
  if (l.prevSched) c.sched = l.prevSched; else delete c.sched;
  if (l.prevDoneBy) { if (l.prevDoneBy.length) c.doneBy = l.prevDoneBy; else delete c.doneBy; }
  const who = choreNow(c, houseClock().date).who, whoName = db.members[who]?.name;
  const text = `Sent back: ${l.title}${whoName ? ` (${whoName})` : ''}${noteText ? `. ${noteText}` : ''}`;
  const mid = docId();
  db.chat[mid] = { memberId: user.id, name: user.name, at: Date.now(), text, photo, kind: 'sent-back' };
  save();
  broadcast({ coll: 'log', id: logId, doc: l }); broadcast({ coll: 'chores', id: l.choreId, doc: c }); broadcast({ coll: 'chat', id: mid, doc: db.chat[mid] });
  if (who && who !== user.id) notify(who, 'chores', { title: 'Chore sent back', body: `${l.title}: ${noteText || 'see the photo'}${needPhoto ? '. Take a picture when it is redone.' : ''}`.slice(0, 180), url: '/#today', tag: `back-${l.choreId}` });
  for (const id of Object.keys(db.logins)) if (id !== user.id && id !== who) notify(id, 'chat', { title: user.name, body: text.slice(0, 180), url: '/#chat', tag: 'chat' });
}

/* ---------- hours and stats for each person, day by day for the last 14 days ---------- */
function statsReport() {
  const today = houseClock().date, dates = [];
  for (let i = STATS_DAYS - 1; i >= 0; i--) dates.push(addDay(today, -i));
  const index = new Map(dates.map((d, i) => [d, i]));
  const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: HOUSE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const people = {};
  const row = id => people[id] = people[id] || { cleaning: dates.map(() => 0), chores: dates.map(() => 0), work: dates.map(() => 0), sessions: 0, delays: 0, snoozes: 0, sentBack: 0, recent: { sessions: 0, delays: 0, snoozes: 0, sentBack: 0 } };
  /* Today only counts the part of a shift or school day that has already happened. */
  const nowTime = houseClock().time, soFar = (date, start, mins) => {
    if (date !== today) return mins;
    const toMins = t => +t.slice(0, 2) * 60 + +t.slice(3);
    return Math.min(mins, Math.max(0, toMins(nowTime) - toMins(start)));
  };
  const bump = (id, kind, date, n) => { const i = index.get(date); if (i !== undefined && db.members[id]) row(id)[kind][i] += n; };
  for (const id of Object.keys(db.logins)) if (db.members[id]) row(id);
  for (const l of Object.values(db.log)) if (!l.rejected && l.stamp && l.by) bump(l.by, 'cleaning', dayOf(l.stamp), +l.minutes || 0);
  for (const l of Object.values(db.log)) if (!l.rejected && l.stamp && l.by) bump(l.by, 'chores', dayOf(l.stamp), 1);
  for (const w of Object.values(db.work)) { const m = t => +t.slice(0, 2) * 60 + +t.slice(3); let d = m(w.end) - m(w.start); if (d <= 0) d += 1440; bump(w.memberId, 'work', w.date, soFar(w.date, w.start, d)); }
  /* School or college times count too, except on holidays and days away. Past days use the current times. */
  for (const [id, sched] of Object.entries(db.schedules)) for (const date of dates) {
    const t = sched.days?.[dayNum(date)];
    if (!t || tripOn(date) || onHoliday(id, date)) continue;
    if (Object.values(db.away).some(a => a.memberId === id && a.allDay !== false && a.from <= date && a.to >= date)) continue;
    const m = v => +v.slice(0, 2) * 60 + +v.slice(3);
    bump(id, 'work', date, soFar(date, t.start, m(t.end) - m(t.start)));
  }
  const since = Date.parse(dates[0] + 'T00:00:00Z');
  for (const a of db.activity) { if (a.at < since || !db.members[a.memberId]) continue; if (a.type === 'delay') row(a.memberId).delays++; if (a.type === 'snooze') row(a.memberId).snoozes++; }
  for (const l of Object.values(db.log)) if (l.rejected && l.rejected.at >= since && l.by && db.members[l.by]) row(l.by).sentBack++;
  /* The same counts for the last 14 days, for the Stats tab. */
  const recentFrom = dates[dates.length - 14], recentSince = Date.parse(recentFrom + 'T00:00:00Z');
  for (const a of db.activity) { if (a.at < recentSince || !db.members[a.memberId]) continue; if (a.type === 'delay') row(a.memberId).recent.delays++; if (a.type === 'snooze') row(a.memberId).recent.snoozes++; }
  for (const l of Object.values(db.log)) if (l.rejected && l.rejected.at >= recentSince && l.by && db.members[l.by]) row(l.by).recent.sentBack++;
  return { dates, people };
}

/* ---------- entertainment nights ---------- */
const NIGHT_ICONS = ['🎬', '🎲', '🍹', '🍖', '👪', '👫', '🎉', '🍿', '🎤', '🎵', '🎂', '🍕', '⚽', '🎳', '🎭', '🏕️', '🏖️', '🎆', '🎁', '☕'];
const canAddNight = user => user.admin || (user.cleaner && groupsOf(db.logins[user.id]).some(n => db.nightGroups.includes(n)));
async function nightsApi(req, res, route, user) {
  const method = req.method, id = route[1];
  if (route[0] === 'night-types') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    if (method === 'POST' && !id) {
      const body = await readJson(req), name = String(body.name || '').trim().slice(0, 40);
      if (!name) return fail(res, 400, 'Type a name for the option.');
      if (Object.values(db.nightTypes).some(t => t.name.toLowerCase() === name.toLowerCase())) return fail(res, 400, 'That option is already on the list.');
      const newId = docId();
      db.nightTypes[newId] = { name, icon: NIGHT_ICONS.includes(body.icon) ? body.icon : '🎉' };
      save(); broadcast({ coll: 'nightTypes', id: newId, doc: db.nightTypes[newId] });
      return send(res, 200, { id: newId });
    }
    if (method === 'DELETE' && id && db.nightTypes[id]) { delete db.nightTypes[id]; save(); broadcast({ coll: 'nightTypes', id, doc: null }); return send(res, 200, { ok: true }); }
    return fail(res, 404, 'That option is no longer on the list.');
  }
  if (route[0] === 'night-groups' && method === 'POST') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    db.nightGroups = cleanGroups(await readJson(req));
    save(); broadcast({ coll: 'logins' });
    return send(res, 200, { ok: true });
  }
  const old = id && db.nights[id];
  if (id && !old && method !== 'PUT') return fail(res, 404, 'That night is no longer on the list.');
  if (!canAddNight(user) && !user.admin) return fail(res, 403, 'Your group can\'t add entertainment nights.');
  if (old && !user.admin && old.createdBy !== user.id) return fail(res, 403, 'Only the person who added it, or an admin, can change this.');
  if (method === 'DELETE' && old) { delete db.nights[id]; save(); broadcast({ coll: 'nights', id, doc: null }); return send(res, 200, { ok: true }); }
  if (method === 'POST' && !id || method === 'PUT') {
    const body = await readJson(req), type = db.nightTypes[body.typeId];
    if (!type && !(old && old.typeId === body.typeId)) return fail(res, 400, 'Choose what kind of night it is.');
    if (!DATE_RE.test(body.date) || !TIME_RE.test(body.time)) return fail(res, 400, 'Choose a date and a time.');
    if (body.date < houseClock().date) return fail(res, 400, "That date has passed.");
    const newId = id || docId();
    db.nights[newId] = { typeId: body.typeId, name: type ? type.name : old.name, icon: type ? type.icon : old.icon, date: body.date, time: body.time, by: old ? old.by : user.name, createdBy: old ? old.createdBy : user.id };
    save(); broadcast({ coll: 'nights', id: newId, doc: db.nights[newId] });
    return send(res, 200, { id: newId });
  }
  return fail(res, 404, 'Not found.');
}
/* Shown to anyone on the sign-in page, so no names of people. */
function whatsOn() {
  const today = houseClock().date;
  const planned = d => d.kind === 'takeaway' || d.kind === 'out' || d.group || d.meal;
  return {
    dinners: Object.entries(db.dinners).filter(([date, d]) => date >= today && planned(d)).sort(([a], [b]) => a < b ? -1 : 1).map(([date, d]) => ({ date, kind: d.kind, meal: d.meal, group: d.group })),
    nights: Object.values(db.nights).filter(n => n.date >= today).sort((a, b) => (a.date + a.time) < (b.date + b.time) ? -1 : 1).map(n => ({ date: n.date, time: n.time, name: n.name, icon: n.icon })),
  };
}

/* ---------- extra time on a device: the admin gets the last 12 hours of cleaning with the request ---------- */
const ASK_DEVICES = ['Mobile', 'Tablet', 'Xbox', 'Laptop'];
const ASK_KEEP_DAYS = 14;
function last12Hours(id) {
  const now = Date.now(), since = now - 12 * 3600 * 1000;
  const done = Object.values(db.log).filter(l => l.by === id && !l.rejected && l.stamp >= since).sort((a, b) => a.stamp - b.stamp);
  return { minutes: done.reduce((t, l) => t + (+l.minutes || 0), 0), jobs: done.map(l => l.title) };
}
const askMins = m => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`);
function pruneAsks() {
  const cutoff = Date.now() - ASK_KEEP_DAYS * 864e5;
  for (const [id, q] of Object.entries(db.deviceAsks)) if (q.at < cutoff) delete db.deviceAsks[id];
}
async function asksApi(req, res, route, user) {
  const method = req.method, id = route[1], q = id && db.deviceAsks[id];
  if (method === 'POST' && !id) {
    if (!user.cleaner) return fail(res, 403, 'Only a cleaner can ask for extra time.');
    const device = (await readJson(req)).device;
    if (!ASK_DEVICES.includes(device)) return fail(res, 400, 'Choose a device.');
    if (Object.values(db.deviceAsks).some(x => x.memberId === user.id && x.device === device && !x.answer)) return fail(res, 400, `You've already asked for extra time on your ${device}. Wait for an answer.`);
    const newId = docId(), { minutes, jobs } = last12Hours(user.id);
    db.deviceAsks[newId] = { memberId: user.id, name: user.name, device, at: Date.now(), minutes, jobs };
    note('ask-time', user.id, { device, minutes, jobs: jobs.length });
    save(); broadcast({ coll: 'logins' });
    const body = `About ${askMins(minutes)} of chores in the last 12 hours. ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} done${jobs.length ? `: ${jobs.join(', ')}` : ''}.`.slice(0, 240);
    for (const [aid, l] of Object.entries(db.logins)) if (l.admin && aid !== user.id) notify(aid, 'chores', { title: `${user.name} wants extra time on ${device}`, body, url: '/#extra', tag: `ask-${newId}` });
    return send(res, 200, { id: newId });
  }
  if (method === 'POST' && q && route[2] === 'answer') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    if (q.answer) return fail(res, 400, 'That has already been answered.');
    q.answer = (await readJson(req)).yes ? 'yes' : 'no'; q.answeredBy = user.name; q.answeredAt = Date.now();
    save(); broadcast({ coll: 'logins' });
    notify(q.memberId, 'chores', { title: `Extra time on ${q.device}`, body: q.answer === 'yes' ? `Yes, from ${user.name}.` : `Not this time, from ${user.name}.`, url: '/#extra', tag: `ask-${id}` });
    return send(res, 200, { ok: true });
  }
  return fail(res, 404, 'That request is no longer here.');
}

/* Cleaners only get their own log, so this tells them who last did the chores they can see. */
function lastDoneFor(user) {
  const out = {};
  for (const l of Object.values(db.log)) {
    if (l.rejected || !l.choreId || !l.date || !db.chores[l.choreId]) continue;
    if ((out[l.choreId]?.stamp || 0) > (l.stamp || 0)) continue;
    out[l.choreId] = { date: l.date, by: l.by || '', stamp: l.stamp || 0 };
  }
  if (!user.admin) for (const id of Object.keys(out)) if (!choreVisibleTo(user.id, { ...db.chores[id], id })) delete out[id];
  return out;
}

/* ---------- activities: anyone can add their own, and admins can add anyone's ---------- */
function cleanOuting(body, user, old) {
  const memberId = user.admin ? String(body.memberId || old?.memberId || user.id) : user.id;
  const activity = String(body.activity || '').trim().slice(0, 40), weekly = !!body.weekly;
  if (!db.members[memberId]) return 'That person no longer exists.';
  if (!activity) return 'Type what the activity is.';
  if (!DATE_RE.test(body.from)) return 'Choose a date.';
  const to = weekly || !body.to ? body.from : body.to;
  if (!DATE_RE.test(to) || to < body.from) return "The last day can't be before the first day.";
  const start = body.start || '', end = body.end || '';
  if (!!start !== !!end || (start && (!TIME_RE.test(start) || !TIME_RE.test(end)))) return 'Enter both times, or leave both blank for all day.';
  if (start && end <= start) return 'The finish time needs to be after the start time.';
  return { memberId, activity, from: body.from, to, start, end, weekly };
}
async function outingsApi(req, res, route, user) {
  const method = req.method, id = route[1], old = id && db.outings[id];
  if (id && !old) return fail(res, 404, 'That activity is no longer here.');
  if (old && !user.admin && old.memberId !== user.id) return fail(res, 403, 'You can only change your own activities.');
  if (method === 'DELETE' && old) { delete db.outings[id]; save(); broadcast({ coll: 'logins' }); return send(res, 200, { ok: true }); }
  if ((method === 'POST' && !id) || (method === 'PUT' && old)) {
    const doc = cleanOuting(await readJson(req), user, old);
    if (typeof doc === 'string') return fail(res, 400, doc);
    const newId = id || docId();
    db.outings[newId] = doc;
    save(); broadcast({ coll: 'logins' });
    return send(res, 200, { id: newId });
  }
  return fail(res, 404, 'Not found.');
}

/* ---------- shopping list ---------- */
const SHOP_MAX = 300;
const SHOP_MAX_QTY = 99;
const SHOP_ORDERED_DAYS = 7;
function pruneShop() {
  const cutoff = Date.now() - SHOP_ORDERED_DAYS * 864e5;
  for (const [id, i] of Object.entries(db.shop)) if (i.ordered && i.ordered.at < cutoff) { delete db.shop[id]; save(); broadcast({ coll: 'shop', id, doc: null }); }
}
function addShopItem(res, text, by) {
  text = String(text || '').trim().slice(0, 80); by = String(by || '').trim().slice(0, 40);
  if (!text) return fail(res, 400, 'Type an item first.');
  if (!by) return fail(res, 400, 'Enter your name so we know who added it.');
  if (Object.keys(db.shop).length >= SHOP_MAX) return fail(res, 400, 'The list is full. Ask an admin to clear some items.');
  const id = docId();
  db.shop[id] = { text, by, at: Date.now() };
  save(); broadcast({ coll: 'shop', id, doc: db.shop[id] });
  return send(res, 200, { id });
}
/* ---------- a person's last 14 days, for admins ---------- */
function reportFor(id) {
  const since = Date.now() - REPORT_DAYS * 864e5, items = [], add = (at, kind, text) => { if (at >= since) items.push({ at, kind, text }); };
  const sum = { chores: 0, minutes: 0, sessions: 0, delays: 0, snoozes: 0, sentBack: 0, autoOut: 0, messages: 0 };
  for (const a of db.activity) {
    if (a.memberId !== id || a.at < since) continue;
    if (a.type === 'signin') add(a.at, 'Sign-in', 'Signed in');
    else if (a.type === 'signout') add(a.at, 'Sign-in', 'Signed out');
    else if (a.type === 'open') add(a.at, 'Sign-in', 'Opened the app');
    else if (a.type === 'ask-time') add(a.at, 'Extra time', `Asked for extra time on ${a.detail.device} (about ${askMins(a.detail.minutes)} of chores, ${a.detail.jobs} jobs done in the last 12 hours)`);
    else if (a.type === 'sick') add(a.at, 'Sick', `Logged as sick by ${a.detail.by}, chores paused for 12 hours`);
    else if (a.type === 'sick-end') add(a.at, 'Sick', `No longer sick, ended by ${a.detail.by}`);
    else if (a.type === 'mode') add(a.at, 'Mode', `Switched to ${a.detail === 'admin' ? 'Admin' : 'Cleaner'} mode`);
    else if (a.type === 'delay') { sum.delays++; add(a.at, 'Delay', `Delayed "${a.detail.title}" by 30 minutes${a.detail.reason ? `: ${a.detail.reason}` : ''}`); }
    else if (a.type === 'snooze') { sum.snoozes++; add(a.at, 'Snooze', `Snoozed ${a.detail.which === 'others' ? "other people's reminders" : 'their reminders'} for 1 hour (${a.detail.count} showing)`); }
    else if (a.type === 'auto-out') { sum.autoOut++; add(a.at, 'Clock', 'Clocked out automatically: no answer to "Are you still cleaning?"'); }
    else if (a.type === 'skip') add(a.at, 'Skip', `Skipped "${a.detail.title}" until next time`);
    else if (a.type === 'review') add(a.at, 'Check', `"${a.detail.title}" ${a.detail.result === 'ok' ? 'accepted' : 'not good enough'}, checked by ${a.detail.by}`);
    else if (a.type === 'shift-edit') add(a.at, 'Clock', `Cleaning session times changed by ${a.detail.by}`);
  }
  for (const l of Object.values(db.log)) {
    if (l.by !== id && l.actor !== id) continue;
    if ((l.stamp || 0) >= since) { if (!l.rejected) sum.chores++; add(l.stamp, 'Chore', `${l.extra ? 'Extra job: ' : 'Did '}"${l.title}"${l.actor && l.actor !== id ? ` (ticked by ${db.members[l.actor]?.name || 'someone else'})` : ''}`); }
    if (l.rejected && l.rejected.at >= since) { sum.sentBack++; add(l.rejected.at, 'Sent back', `"${l.title}" sent back by ${l.rejected.by}${l.rejected.note ? `: ${l.rejected.note}` : ''}`); }
  }
  for (const s of Object.values(db.shifts)) {
    if (s.memberId !== id) continue;
    add(s.start, 'Clock', 'Clocked in');
    if (s.end) add(s.end, 'Clock', `Clocked out after ${Math.round((s.end - s.start) / 60000)} min`);
  }
  for (const l of Object.values(db.log)) if (l.by === id && !l.rejected && l.stamp >= since) sum.minutes += +l.minutes || 0;
  for (const m of Object.values(db.chat)) if (m.memberId === id) { sum.messages++; add(m.at, 'Chat', `Sent a message: ${m.text}`); }
  items.sort((a, b) => b.at - a.at);
  return { memberId: id, days: REPORT_DAYS, summary: sum, items };
}

/* ---------- in-app reminders: never shown while someone is at school, at work or away ---------- */
function houseClock() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: HOUSE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(+process.env.ROTA_TEST_NOW || Date.now())).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const addDay = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dayNum = s => ((new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;
const awayOn = (id, date) => Object.values(db.away).find(a => a.memberId === id && a.from <= date && a.to >= date);
/* With a chore time, a timed night away only takes chores after they leave and before they're back. */
/* Out and back on one day, such as an evening out. Otherwise they're back the morning after. */
const sameDayAway = a => a.allDay === false && a.from === a.to && a.back > a.leave;
const choreAway = (id, date, time) => Object.values(db.away).find(a => a.memberId === id && (sameDayAway(a) ? !!time && date === a.from && time >= a.leave && time < a.back : time && a.allDay === false
  ? (date > a.from && date <= a.to) || (date === a.from && time >= a.leave) || (date === addDay(a.to, 1) && time < a.back)
  : a.from <= date && a.to >= date));
const onHoliday = (id, date) => Object.values(db.holidays).some(h => h.from <= date && h.to >= date && (!(h.people || []).length || h.people.includes(id)));
const tripOn = date => Object.values(db.trips).find(t => t.from <= date && t.to >= date);
function afterTrips(date) { let d = date, t; for (let i = 0; i < 60 && (t = tripOn(d)); i++) d = addDay(t.to, 1); return d; }
/* ---------- off sick: chores wait, with no reminders or alerts, and nobody else is told ---------- */
const SICK_HOURS = 12;
const isSick = id => !!db.sick[id] && db.sick[id].until > (+process.env.ROTA_TEST_NOW || Date.now());
function endSick(id) {
  const s = db.sick[id]; if (!s) return;
  delete db.sick[id];
  /* Chores that fell due while they were sick wait until today, rather than showing as late. */
  const today = houseClock().date;
  for (const [cid, c] of Object.entries(db.chores)) if (c.assignee === id && !c.everyone && !c.done && c.due && c.due >= s.from && c.due < today) { c.due = today; broadcast({ coll: 'chores', id: cid, doc: c }); }
  save(); broadcast({ coll: 'logins' });
}
function checkSick() { for (const id of Object.keys(db.sick)) if (!isSick(id)) endSick(id); }
/* An activity on one day: every week from its first day, or on each day from first to last. */
const outingOn = (o, date) => o.weekly ? date >= o.from && (Date.parse(date) - Date.parse(o.from)) % (7 * 864e5) === 0 : date >= o.from && date <= o.to;
function isBusy(id, { date, time }) {
  if (isSick(id)) return true;
  if (Object.values(db.outings).some(o => o.memberId === id && outingOn(o, date) && (!o.start || (time >= o.start && time < o.end)))) return true;
  if (tripOn(date)) return true;
  if (Object.values(db.away).some(a => a.memberId === id && (sameDayAway(a) ? date === a.from && time >= a.leave && time < a.back : a.allDay !== false ? a.from <= date && a.to >= date :
    (date > a.from && date <= a.to) || (date === a.from && time >= a.leave) || (date === addDay(a.to, 1) && time < a.back)))) return true;
  const t = db.schedules[id]?.days?.[dayNum(date)];
  if (t && !onHoliday(id, date) && t.start <= time && time < t.end) return true;
  const yesterday = addDay(date, -1);
  return Object.values(db.work).some(w => w.memberId === id && (
    (w.date === date && w.start <= time && (w.end <= w.start || time < w.end)) ||
    (w.date === yesterday && w.end <= w.start && time < w.end)));
}
/* A chore's person and date after any one-off move, second person or night away. */
function isBirthday(id, date) {
  const dob = db.logins[id]?.dob; if (!dob) return false;
  const md = dob.slice(5), t = date.slice(5), y = +date.slice(0, 4);
  return md === t || (md === '02-29' && t === '02-28' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)));
}
const isOff = (id, date, time) => !!choreAway(id, date, time) || isBirthday(id, date);
/* The next free person in the same group, starting after this person so it shares out fairly. */
function otherOnLevel(id, date, time, level) {
  /* For a chore with no group, anyone who shares a group with this person can cover. */
  const ids = level ? levelIds(level) : db.logins[id]?.cleaner ? [...new Set(groupsOf(db.logins[id]).flatMap(levelIds))].sort((a, b) => (db.members[a].name || '').localeCompare(db.members[b].name || '')) : [];
  const from = ids.indexOf(id);
  for (let i = 1; i <= ids.length; i++) { const o = ids[(from + i + ids.length) % ids.length]; if (o !== id && !isOff(o, date, time)) return o; }
  return '';
}
/* Chores due during a family holiday wait until the day everyone is home. */
function choreNow(c, today) {
  /* A chore that fell during the holiday stays moved after it has ended, so it isn't late on the first day back. */
  const base = tripOn(c.due) ? c.due : (c.due < today ? today : c.due);
  if (!tripOn(base)) return choreBase(c, today);
  const back = afterTrips(base);
  return choreBase({ ...c, due: back, once: c.once && c.once.date === c.due ? { ...c.once, date: back } : c.once }, today);
}
function choreBase(c, today) {
  if (c.once && c.once.date === c.due) return { due: c.due, who: c.once.assignee };
  const who = c.assignee || '';
  /* A chore that fell on a night away or a birthday stays moved or covered, even after that day has passed. */
  const base = who && isOff(who, c.due, c.time) ? c.due : (c.due < today ? today : c.due);
  if (!who || !isOff(who, base, c.time)) return { due: c.due, who };
  const away = choreAway(who, base, c.time), birthday = isBirthday(who, base);
  const cover = [c.backup, c.backupGroup ? otherOnLevel(who, base, c.time, c.backupGroup) : '', away && away.coverId, (birthday || c.level) ? otherOnLevel(who, base, c.time, c.level) : ''].find(p => p && p !== who && db.members[p] && !isOff(p, base, c.time));
  if (cover) return { due: c.due, who: cover };
  let d = base;
  for (let i = 0; i < 60 && isOff(who, d, c.time); i++) d = addDay(d, 1);
  return { due: d, who };
}
function remindersFor(user) {
  const clock = houseClock(), today = clock.date, login = db.logins[user.id];
  const nowMs = +process.env.ROTA_TEST_NOW || Date.now();
  const out = { late: 0, today: 0, busy: isBusy(user.id, clock), others: [] }, ids = [];
  const yesterday = addDay(today, -1);
  for (const [choreId, chore] of Object.entries(db.chores)) {
    const c = { ...chore, id: choreId };
    if (c.done || !c.due) continue;
    const e = choreNow(c, today);
    const free = !isBirthday(user.id, today) && !isSick(user.id);
    const mine = free && (c.everyone ? login.cleaner && (!(c.people || []).length || c.people.includes(user.id)) && !(c.doneBy || []).includes(user.id) : (e.who === user.id || (!e.who && (c.anyLevel ? levelIds(c.anyLevel).includes(user.id) : login.cleaner))));
    if (!out.busy && mine && !(c.delay && c.delay.until > (+process.env.ROTA_TEST_NOW || Date.now()))) {
      if (e.due < today) { out.late++; ids.push(c.id || ''); }
      else if (e.due === today && clock.time >= (c.time || REMIND_FROM)) { out.today++; ids.push(c.id || ''); }
    }
    if (user.admin && e.due <= yesterday && e.who !== user.id && !isSick(e.who)) out.others.push({ title: c.title, who: c.everyone ? ((c.people || []).length ? c.people.map(p => db.members[p]?.name).filter(Boolean).join(', ') : 'Everyone') : db.members[e.who]?.name || (c.anyLevel ? `anyone in group ${c.anyLevel}` : ''), days: Math.round((Date.parse(today) - Date.parse(e.due)) / 864e5) });
  }
  out.others.sort((a, b) => b.days - a.days);
  if ((login.snoozeMine || 0) > nowMs) { out.late = 0; out.today = 0; out.snoozed = login.snoozeMine; ids.length = 0; }
  Object.defineProperty(out, 'ids', { value: ids, enumerable: false });
  if ((login.snoozeOthers || 0) > nowMs) out.others = [];
  return out;
}

/* ---------- spoken reminders on Home Assistant speakers ----------
 * A chore that is an hour past its time (or its day, for chores from an earlier day) is read out once on the
 * person's speaker, 08:00-21:00. Speakers come from the add-on option "speakers" (Name=media_player.x). */
const SPEAKERS = (() => {
  const map = new Map();
  for (const line of String(process.env.SPEAKERS || '').split('\n')) {
    const m = /^\s*([^=]+?)\s*=\s*(media_player\.[a-z0-9_]+)\s*$/i.exec(line);
    if (m) map.set(m[1].toLowerCase(), m[2].toLowerCase());
  }
  return map;
})();
const SPEAK_LATE_MIN = +(process.env.SPEAK_AFTER_MINUTES || 60);
const plusMinutes = (hhmm, mins) => { const [h, m] = hhmm.split(':').map(Number), t = Math.min(h * 60 + m + mins, 24 * 60 - 1); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
async function haService(domain, service, data) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return false;
  const r = await fetch(`http://supervisor/core/api/services/${domain}/${service}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(`Home Assistant answered ${r.status}`);
  return true;
}
async function speakOverdue() {
  if (!SPEAKERS.size || !process.env.SUPERVISOR_TOKEN) return;
  const clock = houseClock(), today = clock.date;
  if (clock.time < '08:00' || clock.time >= '21:00') return;
  for (const [id, l] of Object.entries(db.logins)) {
    const name = db.members[id]?.name;
    const speaker = name && (SPEAKERS.get(name.toLowerCase()) || SPEAKERS.get('everyone else'));
    if (!speaker) continue;
    const r = remindersFor({ id, ...activeRoles(l) });
    if (db.speakSent[id]?.date !== today) db.speakSent[id] = { date: today, ids: [] };
    const late = r.ids.filter(cid => {
      const c = db.chores[cid];
      if (!c || db.speakSent[id].ids.includes(cid)) return false;
      const e = choreNow(c, today);
      return e.due < today || (e.due === today && clock.time >= plusMinutes(c.time || REMIND_FROM, SPEAK_LATE_MIN));
    });
    if (!late.length) continue;
    db.speakSent[id].ids.push(...late); save();
    const titles = late.map(cid => db.chores[cid].title);
    const message = late.length === 1
      ? `${name}, your job "${titles[0]}" is over an hour late. Please do it now.`
      : `${name}, you have ${late.length} jobs that are over an hour late, including "${titles[0]}". Please check Family Planner.`;
    try {
      await haService('tts', 'speak', { entity_id: process.env.TTS_ENTITY || 'tts.home_assistant_cloud', media_player_entity_id: speaker, message, ...(process.env.TTS_LANGUAGE ? { language: process.env.TTS_LANGUAGE } : {}) });
      console.log(`Spoke on ${speaker}: ${message}`);
    } catch (e) { console.error(`Couldn't speak on ${speaker}: ${e.message}`); }
  }
}

/* ---------- TiviSync pop-ups: a reminder on the TV where the person is signed in to TiviSync ----------
 * Sent through Home Assistant as the event tivisync_announce, aimed at their TiviSync profile. TiviSync only
 * shows it on a TV where that profile is signed in, so it is repeated every TV_REMIND_MINUTES while chores wait. */
const TIVISYNC_URL = process.env.TIVISYNC_URL || 'http://e53481c0-tivisync:8080';
const TV_REMIND_MIN = +(process.env.TV_REMIND_MINUTES || 30);
async function haEvent(type, data) {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return false;
  const r = await fetch(`http://supervisor/core/api/events/${type}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!r.ok) throw new Error(`Home Assistant answered ${r.status}`);
  return true;
}
/* Today's entries from the Reminders list, as that person sees it in the app: their reminders, nights, takeaway
 * and meals out, dinner jobs for their group, and (for admins) everyone's outings and nights away. Only today. */
function addInterval(s, n, unit, dom) {
  const d = new Date(s + 'T00:00:00Z');
  if (unit === 'day') return new Date(d.getTime() + n * 864e5).toISOString().slice(0, 10);
  if (unit === 'week') return new Date(d.getTime() + n * 7 * 864e5).toISOString().slice(0, 10);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + (unit === 'year' ? n * 12 : n), want = dom || d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(want, last))).toISOString().slice(0, 10);
}
function occursOn(date, unit, every, day) {
  if (!date || date > day) return false;
  if (!unit || unit === 'once') return date === day;
  let d = date;
  for (let i = 0; d < day && i < 5000; i++) d = addInterval(d, every || 1, unit, +date.slice(8, 10));
  return d === day;
}
function todayItemsFor(id) {
  const l = db.logins[id], admin = !!l && activeRoles(l).admin, day = houseClock().date, items = [];
  const name = mid => db.members[mid]?.name || 'Someone';
  const add = (title, time) => items.push({ title, time: time || '' });
  for (const e of Object.values(admin ? db.events : eventsFor(id))) if (occursOn(e.date, e.unit, e.every, day)) add(e.title, e.time);
  for (const n of Object.values(db.nights)) if (n.date === day) add(`${n.icon || ''} ${n.name}`.trim(), n.time);
  const din = db.dinners[day];
  if (din && din.kind === 'takeaway') add(din.meal ? `Takeaway night: ${din.meal}` : 'Takeaway night');
  if (din && din.kind === 'out') add(din.meal ? `Eating out: ${din.meal}` : 'Eating out');
  for (const o of Object.values(db.outings)) if ((admin || o.memberId === id) && occursOn(o.from, o.weekly ? 'week' : 'once', 1, day)) add(`${name(o.memberId)}: ${o.activity}`, o.start);
  for (const a of Object.values(db.away)) if ((admin || a.memberId === id) && a.from === day) add(`${name(a.memberId)}: ${a.reason || 'Out for the night'}`, a.allDay === false ? a.leave : '');
  for (const t of Object.values(db.dinnerTasks)) if (t.date === day && (admin || levelIds(t.group).includes(id))) add(t.text);
  return items.sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
}
/* Sends each linked person's list for today to TiviSync, which shows it once, on their first sign-in of the day. */
async function tvDaily() {
  if (!process.env.SUPERVISOR_TOKEN || process.env.TV_DAILY === 'false') return;
  const clock = houseClock();
  if (clock.time < '05:00') return;
  for (const [id, l] of Object.entries(db.logins)) {
    if (!l.tivisync || !db.members[id]) continue;
    const items = todayItemsFor(id);
    const message = items.map(i => `• ${i.time ? i.time + '  ' : ''}${i.title}`).join('\n');
    const stamp = `${clock.date}|${crypto.createHash('sha1').update(message).digest('hex')}`;
    const last = db.dailySent[id] || {};
    if (last.stamp === stamp && Date.now() - (last.at || 0) < 3600e3) continue; // resend hourly in case TiviSync restarted
    if (!items.length && !last.stamp?.startsWith(clock.date)) { db.dailySent[id] = { stamp, at: Date.now() }; continue; }
    try {
      await haEvent('tivisync_announce', { daily: true, profile: l.tivisync, date: clock.date, title: `📅 ${db.members[id].name}, today`, message });
      db.dailySent[id] = { stamp, at: Date.now() }; save();
    } catch (e) { console.error(`Couldn't send today's reminders to TiviSync: ${e.message}`); }
  }
}
/* ---------- TV time earned with chores, and extra jobs an adult must confirm ----------
 * Each chore ticked off adds its minutes to that person's TiviSync time for today (1:1). Extra jobs added by
 * someone who isn't an admin wait for an adult: TiviSync asks on adult TVs and the adults' phones, and the answer
 * comes back as the Home Assistant event tivisync_approval_answer. Undo or "Not done properly" takes the time back. */
function creditTv(l, sign, reason) {
  const login = db.logins[l.by], m = Math.round(+l.minutes || 0), day = houseClock().date;
  if (!login || !login.tivisync || !m) return;
  /* Given once. Undo only takes back time given today; a job sent back always loses its time until it is redone. */
  if (sign > 0 ? l.tvDay : reason === 'sent back' ? !l.tvDay : l.tvDay !== day) return;
  if (sign > 0) l.tvDay = day; else delete l.tvDay;
  haEvent('tivisync_bonus', { profile: login.tivisync, minutes: sign * m, reason: `${reason}: ${l.title}` })
    .then(() => console.log(`TV time ${sign > 0 ? '+' : '-'}${m} min for ${db.members[l.by]?.name}: ${l.title}`))
    .catch(e => console.error(`Couldn't update TV time: ${e.message}`));
}
function askToCheck(id, l) {
  const who = db.members[l.by]?.name || 'Someone';
  haEvent('tivisync_approval', { id: `fp-${id}`, title: `✅ Check ${who}'s extra job`, message: `${l.title}${l.minutes ? ` – about ${l.minutes} min` : ''}`,
    options: [{ label: 'Approve', value: 'yes' }, { label: 'Reject', value: 'no' }] }).catch(e => console.error(`Couldn't ask for the extra job to be checked: ${e.message}`));
}
function checkJob(id, yes, by) {
  const l = db.log[id];
  if (!l || !l.pending) return false;
  delete l.pending;
  if (yes) { l.checkedBy = by; creditTv(l, 1, 'extra job'); }
  else l.rejected = { by, note: 'Not approved', at: Date.now() };
  save(); broadcast({ coll: 'log', id, doc: l });
  if (l.by && db.logins[l.by]) notify(l.by, 'chores', { title: yes ? 'Extra job approved' : 'Extra job not approved', body: `${l.title}, by ${by}.`, url: '/#today', tag: `check-${id}` });
  return true;
}
/* Answers from TiviSync (adult TV or phone) arrive over Home Assistant's event bus. */
function startHaListener() {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token || typeof WebSocket === 'undefined') return;
  let n = 0;
  const connect = () => {
    let ws;
    try { ws = new WebSocket('ws://supervisor/core/websocket'); } catch (e) { setTimeout(connect, 30000); return; }
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      else if (m.type === 'auth_ok') ws.send(JSON.stringify({ id: ++n, type: 'subscribe_events', event_type: 'tivisync_approval_answer' }));
      else if (m.type === 'event' && m.event?.event_type === 'tivisync_approval_answer') {
        const d = m.event.data || {}, hit = /^fp-(.+)$/.exec(String(d.id || ''));
        if (hit && checkJob(hit[1], d.value === 'yes', String(d.by || 'an adult').slice(0, 60))) console.log(`Extra job ${d.value === 'yes' ? 'approved' : 'rejected'} by ${d.by}`);
      }
    };
    ws.onclose = () => setTimeout(connect, 15000);
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  connect();
}

async function tvReminders() {
  if (!process.env.SUPERVISOR_TOKEN || !(TV_REMIND_MIN > 0)) return;
  const clock = houseClock();
  if (clock.time < '08:00' || clock.time >= '21:00') return;
  const nowMs = Date.now();
  for (const [id, l] of Object.entries(db.logins)) {
    if (!l.tivisync || !db.members[id]) continue;
    const r = remindersFor({ id, ...activeRoles(l) });
    const ids = r.ids.filter(cid => db.chores[cid]);
    if (!ids.length) continue;
    if (nowMs - (db.tvSent[id] || 0) < TV_REMIND_MIN * 60 * 1000) continue;
    db.tvSent[id] = nowMs; save();
    const titles = ids.map(cid => db.chores[cid].title);
    const message = ids.length === 1 ? `You have a chore to do: ${titles[0]}.` : `You have ${ids.length} chores to do: ${titles.slice(0, 4).join(', ')}${ids.length > 4 ? '…' : '.'}`;
    try {
      await haEvent('tivisync_announce', { title: `🧹 ${db.members[id].name}, chores to do`, message, profile: l.tivisync, pause: false, speak: false });
      console.log(`TiviSync reminder for ${db.members[id].name}: ${message}`);
    } catch (e) { console.error(`Couldn't send the TiviSync reminder: ${e.message}`); }
  }
}

/* ---------- photos for chores sent back: admins add them, and only admins and that chore's people can open them ---------- */
const photoUploads = new Map();
const photoFile = id => path.join(PHOTO_DIR, id);
function removePhoto(id) {
  delete db.photos[id]; fs.rmSync(photoFile(id), { force: true });
  for (const [lid, l] of Object.entries(db.log)) if (l.rejected?.photo === id) { l.rejected.photo = ''; broadcast({ coll: 'log', id: lid, doc: l }); }
  for (const [mid, m] of Object.entries(db.chat)) if (m.photo === id) { m.photo = ''; broadcast({ coll: 'chat', id: mid, doc: m }); }
}
function prunePhotos() {
  const cutoff = Date.now() - PHOTO_DAYS * 864e5;
  for (const [id, m] of Object.entries(db.photos)) if (m.at < cutoff) { delete db.photos[id]; fs.rmSync(photoFile(id), { force: true }); }
}
async function photoApi(req, res, route, user) {
  const method = req.method, id = route[1];
  if (!id && method === 'POST') {
    if (!user.admin && !Object.values(db.chores).some(c => c.returned?.needPhoto && choreVisibleTo(user.id, c))) return fail(res, 403, ADMIN_ONLY);
    const body = await readJson(req), { upload, index, total } = body;
    if (!ID_RE.test(String(upload)) || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total > 100) return fail(res, 400, "That photo couldn't be read.");
    if (index === 0) photoUploads.set(user.id, { upload, next: 0, parts: [], size: 0 });
    const up = photoUploads.get(user.id);
    if (!up || up.upload !== upload || up.next !== index) return fail(res, 400, 'That photo was interrupted. Try again.');
    const part = Buffer.from(String(body.data || ''), 'base64');
    up.size += part.length;
    if (up.size > MAX_PHOTO) { photoUploads.delete(user.id); return fail(res, 400, 'That photo is too large.'); }
    up.parts.push(part); up.next++;
    if (index < total - 1) return send(res, 200, { ok: true });
    photoUploads.delete(user.id);
    const buffer = Buffer.concat(up.parts);
    if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) return fail(res, 400, "That file isn't a photo the app can use.");
    const newId = docId();
    fs.writeFileSync(photoFile(newId), buffer, { mode: 0o600 });
    db.photos[newId] = { at: Date.now(), by: user.id, choreId: '' };
    prunePhotos(); save();
    return send(res, 200, { id: newId });
  }
  if (id && ID_RE.test(id) && method === 'GET') {
    const m = db.photos[id];
    const chore = m && db.chores[m.choreId];
    if (!m || (!user.admin && !m.public && !(chore && choreVisibleTo(user.id, chore)))) return fail(res, 404, 'That photo is no longer available.');
    let data; try { data = fs.readFileSync(photoFile(id)); } catch { return fail(res, 404, 'That photo is no longer available.'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    return res.end(data);
  }
  return fail(res, 404, 'Not found.');
}

/* ---------- chat: everyone signed in shares one conversation, kept for 14 days ---------- */
function pruneChat() {
  const cutoff = Date.now() - CHAT_DAYS * 864e5;
  let changed = false;
  for (const [id, m] of Object.entries(db.chat)) if (m.at < cutoff) { delete db.chat[id]; changed = true; broadcast({ coll: 'chat', id, doc: null }); }
  if (changed) save();
}
async function chatApi(req, res, route, user) {
  const method = req.method, id = route[1];
  if (!id && method === 'POST') {
    const text = String((await readJson(req)).text || '').trim();
    if (!text) return fail(res, 400, 'Type a message first.');
    if (text.length > CHAT_MAX) return fail(res, 400, `Keep messages under ${CHAT_MAX} characters.`);
    const newId = docId();
    db.chat[newId] = { memberId: user.id, name: user.name, at: Date.now(), text };
    save(); broadcast({ coll: 'chat', id: newId, doc: db.chat[newId] });
    for (const id of Object.keys(db.logins)) if (id !== user.id) notify(id, 'chat', { title: user.name, body: text.slice(0, 180), url: '/#chat', tag: 'chat' });
    return send(res, 200, { id: newId });
  }
  if (id && ID_RE.test(id) && db.chat[id] && method === 'DELETE') {
    if (db.chat[id].memberId !== user.id && !user.admin) return fail(res, 403, ADMIN_ONLY);
    delete db.chat[id];
    save(); broadcast({ coll: 'chat', id, doc: null });
    return send(res, 200, { ok: true });
  }
  return fail(res, 404, 'That message is no longer available.');
}

/* ---------- system updates: this app checks and queues a package, and a separate root helper installs it ---------- */
const uploads = new Map();
let pendingPackage = null;
const packageError = msg => Object.assign(new Error(msg), { packageError: true });
const PACKAGE_PATH = /^home-rota\/(?:server\.js|version\.json|README\.md|install\.sh|deploy\/(?:[A-Za-z0-9._-]+)?|public\/(?:[A-Za-z0-9._-]+\.(?:html|js|css|svg|webmanifest|png|json))?)?$/;
function readPackage(buffer) {
  let raw;
  try { raw = zlib.gunzipSync(buffer, { maxOutputLength: 20 * 1024 * 1024 }); } catch { throw packageError("That isn't a Family Planner update package."); }
  const files = new Map(); let at = 0;
  const text = (b, o, n) => b.subarray(o, o + n).toString('latin1').replace(/\0.*$/s, '');
  while (at + 512 <= raw.length) {
    const head = raw.subarray(at, at + 512);
    if (head.every(b => b === 0)) break;
    const name = text(head, 0, 100), size = parseInt(text(head, 124, 12).trim(), 8), type = String.fromCharCode(head[156]);
    if (text(head, 345, 155) || !Number.isFinite(size) || !['0', '\0', '5'].includes(type) || !PACKAGE_PATH.test(name)) throw packageError("That package contains something an update isn't allowed to include, so it wasn't accepted.");
    if (type !== '5') files.set(name, raw.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  for (const f of ['server.js', 'version.json', 'public/index.html', 'public/app.js', 'public/style.css']) if (!files.has('home-rota/' + f)) throw packageError(`That package is missing ${f}.`);
  let info;
  try { info = JSON.parse(files.get('home-rota/version.json').toString('utf8')); } catch { throw packageError("That package's version file can't be read."); }
  if (!/^\d+\.\d+\.\d+$/.test(info.version || '')) throw packageError("That package doesn't say which version it is.");
  if (info.version === VERSION) throw packageError(`Version ${VERSION} is already installed.`);
  for (const f of ['server.js', 'public/app.js']) {
    const tmp = path.join(UPDATES_DIR, `check-${crypto.randomBytes(6).toString('hex')}.js`);
    fs.writeFileSync(tmp, files.get('home-rota/' + f), { mode: 0o600 });
    const r = spawnSync(process.execPath, ['--check', tmp], { timeout: 20000 });
    fs.unlinkSync(tmp);
    if (r.status !== 0) throw packageError(`${f} in that package has an error, so it wasn't accepted.`);
  }
  return { version: info.version, notes: String(info.notes || '').slice(0, 500) };
}
function updaterStatus() {
  try { return JSON.parse(fs.readFileSync(path.join(UPDATER_DIR, 'status.json'), 'utf8')); } catch { return null; }
}
function noteUpdateResults(st) {
  if (!st || !st.last) return;
  const h = db.updates.find(u => u.id === st.last.id);
  if (h && h.result === 'running' && st.state !== 'running') { h.result = st.last.result; save(); }
}
function queueUpdate(action, id) {
  fs.mkdirSync(UPDATES_DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(UPDATES_DIR, 'request.tmp');
  fs.writeFileSync(tmp, `${action} ${id}\n`, { mode: 0o600 });
  fs.renameSync(tmp, path.join(UPDATES_DIR, 'request'));
}
/* ---------- backup: one file with all the data and photos, sent a piece at a time ---------- */
async function sendBackup(res, user) {
  const { sessions, ...data } = db;
  const put = text => new Promise(ok => { if (res.write(text)) ok(); else res.once('drain', ok); });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="family-planner-backup-${houseClock().date}.json"` });
  await put(`{"app":"home-rota-backup","version":${JSON.stringify(VERSION)},"at":${Date.now()},"db":${JSON.stringify(data)},"photos":{`);
  let first = true;
  for (const id of Object.keys(data.photos)) {
    let bytes;
    try { bytes = await fs.promises.readFile(photoFile(id)); } catch (e) { continue; }
    if (res.destroyed) return;
    await put(`${first ? '' : ','}${JSON.stringify(id)}:"${bytes.toString('base64')}"`);
    first = false;
  }
  res.end('}}');
  db.lastBackup = { at: Date.now(), by: user.name }; save();
}
async function systemApi(req, res, route, user) {
  const method = req.method;
  const st = updaterStatus();
  noteUpdateResults(st);
  if (route[1] === 'status' && method === 'GET') {
    return send(res, 200, { version: VERSION, ready: !!st, state: st?.state || 'idle', releases: st?.releases || [], last: st?.last || null, pending: pendingPackage ? { version: pendingPackage.version, notes: pendingPackage.notes } : null, history: db.updates.slice(-UPDATES_SHOWN).reverse(), lastBackup: db.lastBackup });
  }
  if (route[1] === 'backup' && method === 'GET') return await sendBackup(res, user);
  if (route[1] === 'upload' && method === 'POST') {
    const body = await readJson(req);
    const { id, index, total } = body;
    if (!ID_RE.test(String(id)) || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total > 200) return fail(res, 400, "That upload couldn't be read.");
    if (index === 0) { uploads.clear(); uploads.set(id, { next: 0, parts: [], size: 0 }); }
    const up = uploads.get(id);
    if (!up || up.next !== index) return fail(res, 400, 'That upload was interrupted. Try again.');
    const part = Buffer.from(String(body.data || ''), 'base64');
    up.size += part.length;
    if (up.size > MAX_PACKAGE) { uploads.delete(id); return fail(res, 400, 'That file is too large to be an update.'); }
    up.parts.push(part); up.next++;
    if (index < total - 1) return send(res, 200, { ok: true });
    uploads.delete(id);
    fs.mkdirSync(UPDATES_DIR, { recursive: true, mode: 0o700 });
    const buffer = Buffer.concat(up.parts);
    let info;
    try { info = readPackage(buffer); } catch (e) { if (e.packageError) return fail(res, 400, e.message); throw e; }
    const tmp = path.join(UPDATES_DIR, 'pending.tmp');
    fs.writeFileSync(tmp, buffer, { mode: 0o600 });
    fs.renameSync(tmp, path.join(UPDATES_DIR, 'pending.tgz'));
    pendingPackage = info;
    return send(res, 200, { ready: true, ...info, current: VERSION });
  }
  if (route[1] === 'cancel' && method === 'POST') {
    pendingPackage = null;
    fs.rmSync(path.join(UPDATES_DIR, 'pending.tgz'), { force: true });
    return send(res, 200, { ok: true });
  }
  if ((route[1] === 'install' || route[1] === 'rollback') && method === 'POST') {
    const body = await readJson(req);
    const keys = [[`s:${user.id}`, 5]];
    if (tooMany(keys)) return fail(res, 429, 'Too many failed attempts. Wait 15 minutes and try again.');
    if (!checkPassword(String(body.password || '').slice(0, 200), db.logins[user.id])) { noteFail(keys); return fail(res, 400, "That password isn't right."); }
    if (!st) return fail(res, 400, "The update helper isn't set up on this server.");
    if (st.state === 'running') return fail(res, 400, 'An update is already running.');
    const rollback = route[1] === 'rollback';
    const to = rollback ? st.releases?.[0]?.version : pendingPackage?.version;
    if (!to) return fail(res, 400, rollback ? 'There is no earlier version to go back to.' : 'Upload a package first.');
    const id = docId().replace(/[^A-Za-z0-9_-]/g, '');
    db.updates.push({ id, at: Date.now(), by: user.name, action: route[1], from: VERSION, to, result: 'running' });
    db.updates = db.updates.slice(-UPDATES_SHOWN);
    saveNow();
    queueUpdate(route[1], id);
    if (!rollback) pendingPackage = null;
    return send(res, 200, { id });
  }
  return fail(res, 404, 'Not found.');
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const route = url.pathname.slice(5).split('/').filter(Boolean);
  const method = req.method;
  /* TiviSync asks for someone's outstanding chores when they sign in on a TV. Home Assistant's add-on network only. */
  if (route[0] === 'internal' && route[1] === 'tv-status' && method === 'GET') {
    if (!/^(::ffff:)?172\.3[0-3]\./.test(req.socket.remoteAddress || '')) return fail(res, 403, 'Request refused.');
    const want = String(url.searchParams.get('profile') || '').trim().toLowerCase();
    const hit = Object.entries(db.logins).find(([id, l]) => l.tivisync && db.members[id] && (String(l.tivisync).toLowerCase() === want
      || (db.members[id].name || '').trim().toLowerCase() === want));
    if (!want || !hit) return send(res, 200, { linked: false, chores: [] });
    const [id, l] = hit;
    const r = remindersFor({ id, ...activeRoles(l) });
    const chores = r.ids.filter(cid => db.chores[cid]).map(cid => db.chores[cid].title);
    return send(res, 200, { linked: true, name: db.members[id].name, chores });
  }
  /* Browsers can't send this header across sites without permission, which blocks forged requests. */
  if (method !== 'GET' && req.headers['x-rota'] !== '1') return fail(res, 403, 'Request refused.');

  /* First set-up only: load a backup sent from the Home Assistant sidebar (e.g. copied from the old Family Planner).
   * Refused once anyone has a sign-in, so it can't overwrite real data. */
  if (route[0] === 'import-backup' && method === 'POST') {
    if (!haUser(req)) return fail(res, 403, 'Open Family Planner from the Home Assistant sidebar to do this.');
    if (Object.keys(db.logins).length) return fail(res, 409, 'Family Planner already has data, so a backup can only be loaded from the share folder.');
    const raw = await new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > 300 * 1024 * 1024) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
    });
    let bk; try { bk = JSON.parse(raw); } catch { return fail(res, 400, "That file can't be read as a backup."); }
    if (bk.app !== 'home-rota-backup' || !bk.db || !bk.db.logins) return fail(res, 400, "That file isn't a Family Planner backup.");
    db = { ...empty(), ...bk.db, sessions: {} };
    let photos = 0;
    for (const [id, data] of Object.entries(bk.photos || {})) if (ID_RE.test(id)) { fs.writeFileSync(photoFile(id), Buffer.from(data, 'base64'), { mode: 0o600 }); photos++; }
    saveNow();
    console.log(`Imported a backup from ${new Date(bk.at).toLocaleString('en-GB', { timeZone: HOUSE_TZ })} (${Object.keys(db.logins).length} sign-ins, ${photos} photos)`);
    return send(res, 200, { ok: true, logins: Object.keys(db.logins).length, members: Object.keys(db.members || {}).length, photos });
  }

  if (route[0] === 'login' && method === 'POST') {
    const body = await readJson(req);
    const username = String(body.username || '').trim().toLowerCase().slice(0, 254), password = String(body.password || '').slice(0, 200);
    const ip = clientIp(req);
    const keys = [[`u:${ip}:${username}`, 5], [`i:${ip}`, 30]];
    if (tooMany(keys)) return fail(res, 429, 'Too many failed attempts. Wait 15 minutes and try again.');
    const found = findByUsername(username);
    const ok = found ? checkPassword(password, found[1]) : (checkPassword(password, DUMMY_LOGIN), false);
    if (!ok) { noteFail(keys); return fail(res, 401, "That email and password don't match."); }
    pruneSessions();
    const token = newSession(found[0]);
    note('signin', found[0]);
    const ha = haUser(req);
    if (ha) { db.haLinks[ha.id] = found[0]; save(); console.log(`Home Assistant user "${ha.name}" linked to ${found[1].username}`); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
  }

  if (route[0] === 'whats-on' && req.method === 'GET') return send(res, 200, whatsOn());

  if (!(route[0] === 'logout' && method === 'POST')) haSignIn(req, res);
  const user = currentUser(req);
  if (!user) return fail(res, 401, 'Please sign in.');

  if (route[0] === 'logout' && method === 'POST') {
    delete db.sessions[user.key]; note('signout', user.id);
    const ha = haUser(req); if (ha && db.haLinks[ha.id] === user.id) delete db.haLinks[ha.id];
    save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  if (route[0] === 'state' && method === 'GET') { noteOpen(user.id); return send(res, 200, stateFor(user)); }
  if (route[0] === 'log' && ID_RE.test(route[1] || '') && route[2] === 'check' && method === 'POST') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    const yes = !!(await readJson(req)).yes;
    if (!checkJob(route[1], yes, user.name)) return fail(res, 400, 'That has already been checked.');
    haEvent('tivisync_approval_cancel', { id: `fp-${route[1]}`, by: user.name }).catch(() => {});
    return send(res, 200, { ok: true });
  }
  if (route[0] === 'tivisync-profiles' && method === 'GET') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    try {
      const r = await fetch(`${TIVISYNC_URL}/api/internal/profiles`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`TiviSync answered ${r.status}`);
      const list = await r.json();
      return send(res, 200, { profiles: (Array.isArray(list) ? list : []).map(p => ({ id: String(p.id), name: String(p.name || '') })) });
    } catch (e) { return send(res, 200, { profiles: [], error: "TiviSync couldn't be reached." }); }
  }
  if (route[0] === 'mode' && method === 'POST') {
    const mode = (await readJson(req)).mode;
    if (!user.canSwitch) return fail(res, 403, 'Only someone with both Admin and Cleaner ticked can switch.');
    if (mode !== 'admin' && mode !== 'cleaner') return fail(res, 400, 'Unknown mode.');
    if (mode !== user.mode) { db.logins[user.id].mode = mode; note('mode', user.id, mode); broadcast({ coll: 'logins' }); }
    return send(res, 200, { ok: true });
  }
  if (route[0] === 'logs' && method === 'GET') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    if (route[1] === 'stats') return send(res, 200, statsReport());
    if (route[1]) return send(res, 200, reportFor(route[1]));
    const chores = Object.entries(db.log).map(([id, l]) => ({ id, extra: !!l.extra, title: l.title, at: l.stamp, by: l.by, actor: l.actor, shiftId: l.shiftId || null, roomId: l.roomId, choreId: l.choreId, canReturn: l.prevDue !== undefined && !l.rejected && !!db.chores[l.choreId], rejected: l.rejected || null })).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 500);
    return send(res, 200, { activity: db.activity.filter(a => a.type !== 'delay').slice(-500).reverse(), delays: db.activity.filter(a => a.type === 'delay').slice(-500).reverse(), chores });
  }
  if (route[0] === 'chores' && route[2] === 'skipped' && method === 'POST') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    note('skip', user.id, { title: String((await readJson(req)).title || '').slice(0, 120) });
    return send(res, 200, { ok: true });
  }
  if (route[0] === 'chores' && route[2] === 'delay' && method === 'POST' && ID_RE.test(route[1] || '')) {
    const c = db.chores[route[1]];
    if (!c || (!user.admin && !choreVisibleTo(user.id, c))) return fail(res, 404, 'That chore no longer exists.');
    if (!user.admin && !user.cleaner) return fail(res, 403, 'Only a cleaner or admin can do that.');
    const reason = String((await readJson(req)).reason || '').trim().slice(0, 200);
    if (!reason) return fail(res, 400, 'Say why you are delaying it.');
    const now = +process.env.ROTA_TEST_NOW || Date.now(), today = houseClock().date;
    const until = Math.max(now, c.delay?.until || 0) + DELAY_MINUTES * 60000;
    c.delay = { until, date: today, count: c.delay?.date === today ? c.delay.count + 1 : 1 };
    note('delay', user.id, { choreId: route[1], title: c.title, until, count: c.delay.count, reason });
    save(); broadcast({ coll: 'chores', id: route[1], doc: c });
    return send(res, 200, { until });
  }
  if (route[0] === 'photos') return await photoApi(req, res, route, user);
  if (route[0] === 'log' && route[2] === 'return' && method === 'POST' && ID_RE.test(route[1] || '')) {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    const logId = route[1], l = db.log[logId], body = await readJson(req);
    const note = String(body.note || '').trim().slice(0, 500), photo = body.photo ? String(body.photo) : '';
    if (!l) return fail(res, 404, 'That entry no longer exists.');
    const c = db.chores[l.choreId];
    if (!c) return fail(res, 404, 'That chore no longer exists.');
    if (l.rejected) return fail(res, 400, 'That has already been sent back.');
    if (l.prevDue === undefined) return fail(res, 400, "That entry can't be sent back.");
    if (!note && !photo) return fail(res, 400, 'Add a note or a photo so they know what to fix.');
    if (photo && !db.photos[photo]) return fail(res, 400, "That photo couldn't be found. Try adding it again.");
    if (Object.values(db.log).some(o => o.choreId === l.choreId && !o.rejected && (o.stamp || 0) > (l.stamp || 0))) return fail(res, 400, 'This chore has been done again since, so this one can no longer be sent back.');
    sendBack(user, logId, l, c, note, photo, !!body.needPhoto);
    return send(res, 200, { ok: true });
  }
  if (route[0] === 'reviews' && ID_RE.test(route[1] || '') && method === 'POST') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    const rid = route[1], r = db.reviews[rid];
    if (!r) return fail(res, 404, 'That has already been checked.');
    const l = db.log[r.logId], c = db.chores[r.choreId];
    if (route[2] === 'accept') {
      delete db.reviews[rid];
      if (r.photo) removePhoto(r.photo);
      if (r.original) removePhoto(r.original);
      if (l) { l.accepted = { by: user.name, at: Date.now() }; creditTv(l, 1, 'redone and checked'); broadcast({ coll: 'log', id: r.logId, doc: l }); }
      note('review', r.memberId, { title: r.title, by: user.name, result: 'ok' });
      save(); broadcast({ coll: 'reviews', id: rid, doc: null });
      notify(r.memberId, 'chores', { title: 'Chore accepted', body: `${r.title} is good. Thank you.`, url: '/#today', tag: `review-${rid}` });
      return send(res, 200, { ok: true });
    }
    if (route[2] === 'reject') {
      if (!l || !c) return fail(res, 404, 'That chore no longer exists.');
      const body = await readJson(req), noteText = String(body.note || '').trim().slice(0, 500), newPhoto = body.photo ? String(body.photo) : '';
      if (!noteText && !newPhoto) return fail(res, 400, 'Add a note or a photo so they know what to fix.');
      if (newPhoto && !db.photos[newPhoto]) return fail(res, 400, "That photo couldn't be found. Try adding it again.");
      delete db.reviews[rid];
      /* Without a new picture, the one they sent shows what is wrong. */
      const used = newPhoto || r.photo;
      if (r.photo && r.photo !== used) removePhoto(r.photo);
      if (r.original && r.original !== used) removePhoto(r.original);
      note('review', r.memberId, { title: r.title, by: user.name, result: 'rejected' });
      sendBack(user, r.logId, l, c, noteText, used, true);
      broadcast({ coll: 'reviews', id: rid, doc: null });
      return send(res, 200, { ok: true });
    }
  }
  if (route[0] === 'outings') return await outingsApi(req, res, route, user);
  if (route[0] === 'device-asks') return await asksApi(req, res, route, user);
  if (['nights', 'night-types', 'night-groups'].includes(route[0])) return await nightsApi(req, res, route, user);
  if (route[0] === 'shop') {
    if (route[1] === 'items' && !route[2] && method === 'POST') return addShopItem(res, (await readJson(req)).text, user.name);
    const id = route[2], item = id && db.shop[id];
    if (route[1] === 'items' && item && route[3] === 'qty' && method === 'POST') {
      if (item.ordered) return fail(res, 400, 'That has already been ordered.');
      const delta = +(await readJson(req)).delta;
      if (delta !== 1 && delta !== -1) return fail(res, 400, 'Add or take away one at a time.');
      item.qty = Math.min(SHOP_MAX_QTY, Math.max(1, (item.qty || 1) + delta));
      save(); broadcast({ coll: 'shop', id, doc: item });
      return send(res, 200, { qty: item.qty });
    }
    if (route[1] === 'items' && item) {
      if (!user.admin) return fail(res, 403, ADMIN_ONLY);
      if (method === 'DELETE') { delete db.shop[id]; save(); broadcast({ coll: 'shop', id, doc: null }); return send(res, 200, { ok: true }); }
      if (method === 'POST' && route[3] === 'tick') {
        const on = (await readJson(req)).ordered !== false;
        if (on) item.ordered = { at: Date.now(), by: user.name }; else delete item.ordered;
        save(); broadcast({ coll: 'shop', id, doc: item });
        return send(res, 200, { ok: true });
      }
    }
    return fail(res, 404, 'That item is no longer on the list.');
  }
  if (route[0] === 'push') {
    if (route[1] === 'key' && method === 'GET') return send(res, 200, { key: vapidPublic(), prefs: pushPrefs(user.id), devices: (db.push[user.id] || []).length });
    if (route[1] === 'subscribe' && method === 'POST') {
      const sub = (await readJson(req)).subscription;
      if (!sub || !allowedEndpoint(sub.endpoint) || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return fail(res, 400, "That device can't receive notifications.");
      const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: Date.now() };
      /* A device belongs to whoever signed in on it last. */
      for (const id of Object.keys(db.push)) db.push[id] = db.push[id].filter(s => s.endpoint !== clean.endpoint);
      (db.push[user.id] = db.push[user.id] || []).push(clean);
      db.push[user.id] = db.push[user.id].slice(-10);
      save();
      return send(res, 200, { ok: true });
    }
    if (route[1] === 'unsubscribe' && method === 'POST') {
      const endpoint = String((await readJson(req)).endpoint || '');
      db.push[user.id] = (db.push[user.id] || []).filter(s => s.endpoint !== endpoint);
      save();
      return send(res, 200, { ok: true });
    }
    if (route[1] === 'prefs' && method === 'POST') {
      const b = await readJson(req);
      db.pushPrefs[user.id] = { chat: b.chat !== false, chores: b.chores !== false, clock: b.clock !== false };
      save();
      return send(res, 200, { ok: true });
    }
    if (route[1] === 'test' && method === 'POST') {
      if (!(db.push[user.id] || []).length) return send(res, 200, { results: [] });
      const results = await Promise.all(db.push[user.id].map(sub => deliver(user.id, sub, { title: 'Family Planner', body: 'Notifications are working on this device.', url: '/', tag: 'test' })));
      return send(res, 200, { results });
    }
    return fail(res, 404, 'Not found.');
  }
  if (route[0] === 'away-reasons') {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    const id = route[1];
    if (method === 'DELETE' && id && db.awayReasons[id]) { delete db.awayReasons[id]; save(); broadcast({ coll: 'awayReasons', id, doc: null }); return send(res, 200, { ok: true }); }
    if (method === 'POST' || (method === 'PUT' && id && db.awayReasons[id])) {
      const name = String((await readJson(req)).name || '').trim().slice(0, 40);
      if (!name) return fail(res, 400, 'Type a reason.');
      if (Object.entries(db.awayReasons).some(([k, r]) => k !== id && r.name.toLowerCase() === name.toLowerCase())) return fail(res, 400, 'That reason is already on the list.');
      const newId = id || docId();
      db.awayReasons[newId] = { name };
      if (id) for (const a of Object.values(db.away)) if (a.reasonId === id) a.reason = name;
      save(); broadcast({ coll: 'awayReasons', id: newId, doc: db.awayReasons[newId] }); broadcast({ coll: 'logins' });
      return send(res, 200, { id: newId });
    }
    return fail(res, 404, 'That reason is no longer on the list.');
  }
  if (route[0] === 'sick' && ID_RE.test(route[1] || '')) {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    const id = route[1];
    if (!db.members[id]) return fail(res, 404, 'That person no longer exists.');
    if (method === 'POST') {
      const nowMs = +process.env.ROTA_TEST_NOW || Date.now(), until = nowMs + SICK_HOURS * 3600 * 1000;
      db.sick[id] = { from: db.sick[id]?.from || houseClock().date, until, by: user.name };
      note('sick', id, { until, by: user.name });
      save(); broadcast({ coll: 'logins' });
      return send(res, 200, { until });
    }
    if (method === 'DELETE') {
      if (db.sick[id]) { note('sick-end', id, { by: user.name }); endSick(id); }
      return send(res, 200, { ok: true });
    }
  }
  if (route[0] === 'reminders' && route[1] === 'snooze' && method === 'POST') {
    const which = (await readJson(req)).which === 'others' ? 'others' : 'mine';
    if (which === 'others' && !user.admin) return fail(res, 403, ADMIN_ONLY);
    const r = remindersFor(user), count = which === 'mine' ? r.late + r.today : r.others.length;
    db.logins[user.id][which === 'mine' ? 'snoozeMine' : 'snoozeOthers'] = (+process.env.ROTA_TEST_NOW || Date.now()) + SNOOZE;
    note('snooze', user.id, { which, count });
    return send(res, 200, { ok: true });
  }
  if (route[0] === 'reminders' && method === 'GET') return send(res, 200, remindersFor(user));
  if (route[0] === 'chat') return await chatApi(req, res, route, user);
  if (route[0] === 'events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const client = { res, key: user.key };
    streams.add(client);
    req.on('close', () => streams.delete(client));
    return;
  }

  /* Shared data: rooms, chores, the completion log, app settings */
  if (route[0] === 'd' && route.length === 3 && SHARED.includes(route[1]) && ID_RE.test(route[2])) {
    const [, coll, id] = route;
    if (!user.admin && coll === 'events') {
      /* Anyone can keep their own reminders, and admins can set them for anyone. */
      if (db.events[id] && db.events[id].createdBy !== user.id) return fail(res, 403, ADMIN_ONLY);
    } else if (!user.admin) {
      if (coll !== 'chores' && coll !== 'log') return fail(res, 403, ADMIN_ONLY);
      if (!user.cleaner) return fail(res, 403, 'Only a cleaner or admin can tick off chores.');
      if (coll === 'chores' && method === 'DELETE') return fail(res, 403, ADMIN_ONLY);
      if (coll === 'log' && method === 'DELETE' && db.log[id]?.actor !== user.id) return fail(res, 403, ADMIN_ONLY);
    }
    if (method === 'PUT') {
      let doc = await readJson(req);
      delete doc.id;
      if (coll === 'schedules') {
        if (!db.members[id]) return fail(res, 404, 'That person no longer exists.');
        doc = cleanSchedule(doc);
        if (!doc) return fail(res, 400, 'Each finish time needs to be after its start time.');
      }
      if (coll === 'work') {
        doc = cleanWork(doc);
        if (!doc) return fail(res, 400, 'Enter a date, a start time and a finish time.');
        if (!db.members[doc.memberId]) return fail(res, 404, 'That person no longer exists.');
        if (!user.admin && doc.memberId !== user.id) return fail(res, 403, ADMIN_ONLY);
      }
      if (coll === 'dinnerTasks') {
        const text = String(doc.text || '').trim().slice(0, 100), group = +doc.group;
        if (!text) return fail(res, 400, 'Type what needs doing.');
        if (!db.dinners[doc.dinner]) return fail(res, 400, 'That dinner is no longer planned.');
        if (!DATE_RE.test(doc.date) || doc.date > doc.dinner) return fail(res, 400, "Choose a date that isn't after the dinner.");
        if (!GROUPS.includes(group)) return fail(res, 400, 'Choose a group.');
        doc = { dinner: doc.dinner, text, date: doc.date, group };
      }
      if (coll === 'dinners') {
        if (!DATE_RE.test(id)) return fail(res, 400, "That day couldn't be read.");
        const kind = ['takeaway', 'out'].includes(doc.kind) ? doc.kind : 'home';
        doc = { kind, meal: String(doc.meal || '').trim().slice(0, 80), group: kind === 'home' && GROUPS.includes(+doc.group) ? +doc.group : 0 };
      }
      if (coll === 'trips') {
        const name = String(doc.name || '').trim().slice(0, 60);
        if (!name || !DATE_RE.test(doc.from) || !DATE_RE.test(doc.to) || doc.from > doc.to) return fail(res, 400, 'Enter a name, and a last day that is not before the first day.');
        doc = { name, from: doc.from, to: doc.to };
      }
      if (coll === 'events') {
        doc = cleanEvent(doc, user, db.events[id]);
        if (!doc) return fail(res, 400, 'Enter a title and a date.');
      }
      if (coll === 'away') {
        doc = cleanAway(doc);
        if (!doc) return fail(res, 400, "Choose who's away, a last night that isn't before the first, and a different second person.");
      }
      if (coll === 'holidays') {
        doc = cleanHoliday(doc);
        if (!doc) return fail(res, 400, 'Enter a name, and a last day that is not before the first day.');
      }
      if (coll === 'chores' && !user.admin && db.chores[id] && !choreVisibleTo(user.id, db.chores[id]) && !(doc.assignee === user.id && db.chores[id].rotate)) return fail(res, 403, ADMIN_ONLY);
      if (coll === 'chores' && !user.admin && !cleanerMayUpdateChore(db.chores[id], doc)) return fail(res, 403, ADMIN_ONLY);
      if (coll === 'chores' && doc.time !== undefined && !TIME_RE.test(doc.time)) delete doc.time;
      if (coll === 'log') {
        if (!user.admin && db.log[id]) return fail(res, 403, ADMIN_ONLY);
        doc.actor = user.id; doc.stamp = Date.now();
        if (doc.extra) {
          doc.extra = true;
          doc.title = String(doc.title || '').trim().slice(0, 120);
          if (!doc.title) return fail(res, 400, 'Type what you did.');
          doc.minutes = Math.max(0, Math.min(600, Math.round(+doc.minutes || 0)));
          doc.date = houseClock().date;
          delete doc.choreId; delete doc.prevDue;
          if (!user.admin) doc.by = user.id;
        } else delete doc.extra;
        /* A picture of the finished job goes to the admins to check. */
        const asked = db.chores[doc.choreId]?.returned;
        if (doc.proof && db.photos[doc.proof]?.by === user.id && asked?.needPhoto) {
          db.photos[doc.proof].choreId = doc.choreId;
          const rid = docId();
          db.reviews[rid] = { logId: id, choreId: doc.choreId, title: doc.title, memberId: user.id, name: user.name, photo: doc.proof, original: asked.photo || '', note: asked.note || '', at: Date.now() };
          broadcast({ coll: 'reviews', id: rid, doc: db.reviews[rid] });
          for (const [aid, al] of Object.entries(db.logins)) if (al.admin && aid !== user.id) notify(aid, 'chores', { title: 'Check a redone chore', body: `${user.name} has redone ${doc.title}.`, url: '/#today', tag: `review-${rid}` });
        } else delete doc.proof;
      }
      if (coll === 'chores' && !user.admin && db.chores[id]?.returned?.needPhoto && doc.returned === undefined && !Object.values(db.reviews).some(r => r.choreId === id)) return fail(res, 403, 'Take a picture of the finished job first.');
      if (coll === 'chores' && db.chores[id]?.returned?.photo && !db.chores[id].returned.needPhoto && doc.returned?.photo !== db.chores[id].returned.photo) removePhoto(db.chores[id].returned.photo);
      const newTick = coll === 'log' && !db.log[id] && !doc.rejected;
      if (newTick && doc.extra && !user.admin) doc.pending = true; else if (coll === 'log') delete doc.pending;
      if (coll === 'log' && db.log[id]) { if (db.log[id].tvDay) doc.tvDay = db.log[id].tvDay; else delete doc.tvDay; }
      db[coll][id] = doc;
      /* A sent-back job redone with a picture earns its time back only when an adult accepts the picture. */
      if (newTick) { if (doc.pending) askToCheck(id, doc); else if (!doc.proof) creditTv(doc, 1, doc.extra ? 'extra job' : 'chore'); }
      /* Admins hear when a chore is done, unless they ticked it themselves. */
      if (newTick) haEvent('tivisync_job_done', { who: db.members[doc.by]?.name || user.name, title: doc.title }).catch(() => {}); // small ✅ box on the chosen TVs
      if (newTick) { const who = db.members[doc.by]?.name || user.name; for (const [aid, al] of Object.entries(db.logins)) if (al.admin && aid !== user.id) notify(aid, 'clock', { title: doc.extra ? 'Extra job done' : 'Chore done', body: doc.extra ? `${who} did an extra job: ${doc.title}.` : `${who} has done ${doc.title}.`, url: '/#today', tag: `done-${id}` }); }
      if (coll === 'log') pruneLog();
      save(); broadcast(PRIVATE.includes(coll) ? { coll: 'logins' } : { coll, id, doc });
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      if (coll === 'log' && db.log[id]) {
        const old = db.log[id];
        creditTv(old, -1, 'undone');
        if (old.pending) haEvent('tivisync_approval_cancel', { id: `fp-${id}`, by: user.name }).catch(() => {});
      }
      delete db[coll][id];
      if (coll === 'dinners') for (const [tid, t] of Object.entries(db.dinnerTasks)) if (t.dinner === id) { delete db.dinnerTasks[tid]; broadcast({ coll: 'dinnerTasks', id: tid, doc: null }); }
      save(); broadcast(PRIVATE.includes(coll) ? { coll: 'logins' } : { coll, id, doc: null });
      return send(res, 200, { ok: true });
    }
  }

  /* Clocking in and out. Cleaners clock themselves. Admins can also clock in cleaners and people without a sign-in. */
  if (route[0] === 'shifts' && ID_RE.test(route[1] || '') && db.shifts[route[1]]) {
    if (!user.admin) return fail(res, 403, ADMIN_ONLY);
    const id = route[1], shift = db.shifts[id];
    if (method === 'DELETE') {
      delete db.shifts[id];
      save(); broadcast({ coll: 'shifts', id, doc: null, owner: shift.memberId });
      return send(res, 200, { ok: true });
    }
    if (method === 'PATCH') {
      const body = await readJson(req), start = +body.start, stillIn = !shift.end && !body.end, end = stillIn ? null : +body.end;
      if (!Number.isFinite(start) || start <= 0) return fail(res, 400, 'Enter a start time.');
      if (stillIn) {
        if (start > Date.now() + 60000) return fail(res, 400, "The start time can't be in the future.");
        Object.assign(shift, { start, edited: true });
        note('shift-edit', shift.memberId, { by: user.name });
        save(); broadcast({ coll: 'shifts', id, doc: shift, owner: shift.memberId });
        return send(res, 200, { ok: true });
      }
      if (!Number.isFinite(end) || end <= start) return fail(res, 400, 'The finish time needs to be after the start time.');
      if (end > Date.now() + 60000) return fail(res, 400, "The finish time can't be in the future.");
      if (end - start > 24 * 3600 * 1000) return fail(res, 400, 'A session can be 24 hours at most.');
      Object.assign(shift, { start, end, edited: true }); delete shift.auto;
      note('shift-edit', shift.memberId, { by: user.name });
      save(); broadcast({ coll: 'shifts', id, doc: shift, owner: shift.memberId });
      return send(res, 200, { ok: true });
    }
  }

  /* System updates: system users only */
  if (route[0] === 'system') {
    if (!user.system) return fail(res, 403, 'Only a system user can do that.');
    return await systemApi(req, res, route, user);
  }

  /* Changing your own password */
  if (route[0] === 'password' && method === 'POST') {
    const body = await readJson(req);
    const login = db.logins[user.id], next = String(body.next || '');
    if (!checkPassword(String(body.current || '').slice(0, 200), login)) return fail(res, 400, "Your current password isn't right.");
    if (next.length < MIN_PASSWORD || next.length > 200) return fail(res, 400, `Use at least ${MIN_PASSWORD} characters.`);
    Object.assign(login, hashPassword(next));
    dropSessions(user.id, user.key); save();
    return send(res, 200, { ok: true });
  }

  /* Household: admins only */
  if (route[0] === 'members') {
    if (!user.admin) return fail(res, 403, 'Only a household admin can do that.');
    const id = route[1];
    if (id && !ID_RE.test(id)) return fail(res, 400, 'Unknown person.');
    /* Otherwise an admin could reset a system user's password and sign in as them. */
    if (id && db.logins[id]?.system && !user.system && (method === 'DELETE' || route[2] === 'login')) return fail(res, 403, 'Only a system user can change a system user\'s sign-in.');
    if (method === 'POST' && !id) {
      const name = cleanName((await readJson(req)).name);
      if (!name) return fail(res, 400, 'Enter a name.');
      const newId = docId();
      db.members[newId] = { name };
      save(); broadcast({ coll: 'members', id: newId, doc: db.members[newId] });
      return send(res, 200, { id: newId });
    }
    if (!id || !db.members[id]) return fail(res, 404, 'That person no longer exists.');
    if (method === 'PATCH' && !route[2]) {
      const name = cleanName((await readJson(req)).name);
      if (!name) return fail(res, 400, 'Enter a name.');
      db.members[id].name = name;
      save(); broadcast({ coll: 'members', id, doc: db.members[id] });
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE' && !route[2]) {
      if (id === user.id) return fail(res, 400, "You can't remove yourself.");
      if (db.logins[id]?.admin && adminCount() <= 1) return fail(res, 400, 'The household needs at least one admin.');
      if (db.logins[id]?.system && systemCount() <= 1) return fail(res, 400, 'The household needs at least one system user.');
      delete db.members[id]; delete db.logins[id]; delete db.schedules[id];
      delete db.push[id]; delete db.pushPrefs[id]; delete db.pushSent[id];
      for (const [aid, a] of Object.entries(db.away)) { if (a.memberId === id) delete db.away[aid]; else if (a.coverId === id) a.coverId = ''; }
      for (const c of Object.values(db.chores)) { if (c.once?.assignee === id) delete c.once; if (c.backup === id) delete c.backup; }
      dropSessions(id);
      for (const h of Object.values(db.holidays)) h.people = (h.people || []).filter(p => p !== id);
      const running = openShift(id); if (running) db.shifts[running.id].end = Date.now();
      for (const [cid, c] of Object.entries(db.chores)) if (c.assignee === id) { c.assignee = ''; broadcast({ coll: 'chores', id: cid, doc: c }); }
      refillLevels();
      save(); broadcast({ coll: 'members', id, doc: null }); broadcast({ coll: 'logins' });
      return send(res, 200, { ok: true });
    }
    /* PUT sets or resets someone's sign-in. DELETE removes it but keeps them on the rota. */
    if (route[2] === 'login' && method === 'PUT') {
      const body = await readJson(req);
      const old = db.logins[id];
      const username = String(body.username || '').trim().toLowerCase().slice(0, 254), password = String(body.password || '');
      /* Accounts made before email sign-in can keep their old name until someone changes it. */
      if (username !== old?.username && !USER_RE.test(username)) return fail(res, 400, EMAIL_ERROR);
      const clash = findByUsername(username);
      if (clash && clash[0] !== id) return fail(res, 400, 'That email address is already in use.');
      if ((password || !old) && (password.length < MIN_PASSWORD || password.length > 200)) return fail(res, 400, `Use at least ${MIN_PASSWORD} characters for the password.`);
      const admin = !!body.admin, cleaner = !!body.cleaner;
      const system = user.system ? !!body.system : !!old?.system;
      if (!admin && !cleaner && !system) return fail(res, 400, 'Tick at least one box.');
      if (old?.admin && !admin && adminCount() <= 1) return fail(res, 400, 'The household needs at least one admin.');
      if (old?.system && !system && systemCount() <= 1) return fail(res, 400, 'The household needs at least one system user.');
      const dob = String(body.dob || '');
      if (dob && (!DATE_RE.test(dob) || dob > houseClock().date)) return fail(res, 400, "Enter a date of birth that isn't in the future.");
      const tivisync = /^\d{1,9}$/.test(String(body.tivisync || '')) ? String(body.tivisync) : '';
      db.logins[id] = { ...old, username, admin, cleaner, system, level: cleanGroups(body)[0] || 1, groups: cleanGroups(body), dob, tivisync, ...(password ? hashPassword(password) : {}) };
      /* If you tick Cleaner on your own admin account, you stay in Admin mode until you switch. */
      if (id === user.id && !old?.cleaner && cleaner && admin) db.logins[id].mode = 'admin';
      if (password) { if (id !== user.id) dropSessions(id); else dropSessions(id, user.key); }
      if (!cleaner && !admin) { const running = openShift(id); if (running) db.shifts[running.id].end = Date.now(); }
      refillLevels();
      save(); broadcast({ coll: 'logins' });
      return send(res, 200, { ok: true });
    }
    /* Quick group setup from the Progress tab: changes only the groups, nothing else about the sign-in. */
    if (route[2] === 'groups' && method === 'PUT') {
      const l = db.logins[id];
      if (!l || !l.cleaner) return fail(res, 400, 'Only people with a cleaner sign-in can be in a group.');
      const groups = cleanGroups(await readJson(req));
      l.groups = groups; l.level = groups[0] || 1;
      refillLevels();
      save(); broadcast({ coll: 'logins' });
      return send(res, 200, { ok: true, groups });
    }
    if (route[2] === 'login' && method === 'DELETE') {
      if (id === user.id) return fail(res, 400, "You can't remove your own sign-in.");
      if (db.logins[id]?.admin && adminCount() <= 1) return fail(res, 400, 'The household needs at least one admin.');
      if (db.logins[id]?.system && systemCount() <= 1) return fail(res, 400, 'The household needs at least one system user.');
      delete db.logins[id]; dropSessions(id); delete db.push[id];
      refillLevels();
      save(); broadcast({ coll: 'logins' });
      return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, 'Not found.');
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const FILES = new Set(['index.html', 'app.js', 'sw.js', 'style.css', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest']);
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};
function serveStatic(req, res, url) {
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!FILES.has(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  fs.readFile(path.join(PUBLIC_DIR, name), (err, data) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)], 'Cache-Control': 'no-cache', ...SECURITY });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ---------- command line: create the first admin, or reset a lost password ---------- */
function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) rl._writeToOutput = s => { if (s.startsWith(question)) process.stdout.write(question); };
    rl.question(question, a => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write('\n'); resolve(a); });
  });
}
async function cli(args) {
  load();
  if (args[0] === 'add-admin' && args[1]) {
    const username = args[1].toLowerCase();
    const found = findByUsername(username);
    if (!found && !USER_RE.test(username)) throw new Error(EMAIL_ERROR);
    const password = process.env.ROTA_PASSWORD || await ask(`Password for ${username}: `, true);
    if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
    const id = found ? found[0] : docId();
    if (!found) db.members[id] = { name: args[2] || username };
    db.logins[id] = { cleaner: false, system: false, ...db.logins[id], username, admin: true, ...hashPassword(password) };
    dropSessions(id);
    saveNow();
    console.log(`${username} can now sign in as an admin. Start the service again if you stopped it.`);
    return;
  }
  if (args[0] === 'restore' && args[1]) {
    const running = await fetch(`http://127.0.0.1:${PORT}/healthz`).then(() => true, () => false);
    if (running) throw new Error('Stop the service first: systemctl stop home-rota');
    let backup;
    try { backup = JSON.parse(fs.readFileSync(args[1], 'utf8')); } catch (e) { throw new Error(`That file can't be read as a backup: ${e.message}`); }
    if (backup.app !== 'home-rota-backup' || !backup.db || !backup.db.logins) throw new Error("That file isn't a Family Planner backup.");
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `before-restore-${Date.now()}.json`));
    db = { ...empty(), ...backup.db, sessions: {} };
    for (const [id, data] of Object.entries(backup.photos || {})) if (ID_RE.test(id)) fs.writeFileSync(photoFile(id), Buffer.from(data, 'base64'), { mode: 0o600 });
    saveNow();
    /* Run as root, the files still need to belong to the service. */
    if (process.getuid && process.getuid() === 0) {
      const { uid, gid } = fs.statSync(DATA_DIR);
      fs.chownSync(DB_FILE, uid, gid);
      for (const f of fs.readdirSync(PHOTO_DIR)) fs.chownSync(path.join(PHOTO_DIR, f), uid, gid);
    }
    console.log(`Restored the backup from ${new Date(backup.at).toLocaleString('en-GB', { timeZone: HOUSE_TZ })}. Now run: systemctl start home-rota`);
    return;
  }
  if (args[0] === 'accounts') {
    for (const [id, l] of Object.entries(db.logins)) console.log(`${l.username}  (${db.members[id]?.name || 'no name'}): ${[l.cleaner && 'Cleaner', l.admin && 'Admin', l.system && 'System user'].filter(Boolean).join(', ') || 'no boxes ticked'}`);
    if (!Object.keys(db.logins).length) console.log('No accounts yet.');
    return;
  }
  if (args[0] === 'make-system' && args[1]) {
    const found = findByUsername(args[1].toLowerCase());
    if (!found) throw new Error(`No account signs in as ${args[1]}. Run "node server.js accounts" to see them.`);
    found[1].system = true;
    saveNow();
    console.log(`${found[1].username} is now a system user. Start the service again if you stopped it.`);
    return;
  }
  console.log('Usage: node server.js                     start the server\n       node server.js add-admin <email> [name]   create an admin or reset a password\n       node server.js make-system <email>   tick the System user box\n       node server.js restore <file>   put a downloaded backup back, with the service stopped\n       node server.js accounts   list accounts');
}

/* ---------- start ---------- */
function start() {
  load(); pruneSessions(); backup(); closeLongShifts(); checkSick(); pruneChat(); prunePhotos(); pruneEvents(); pruneShop();
  noteUpdateResults(updaterStatus());
  db.updates = db.updates.slice(-UPDATES_SHOWN);
  /* Nothing uploaded needs keeping once the app has restarted. */
  try { for (const f of fs.readdirSync(UPDATES_DIR)) if (f !== 'request') fs.rmSync(path.join(UPDATES_DIR, f), { force: true }); } catch {}
  setInterval(closeLongShifts, +process.env.ROTA_CHECK_EVERY || 60 * 1000).unref();
  setInterval(checkSick, +process.env.ROTA_CHECK_EVERY || 60 * 1000).unref();
  setInterval(() => { pruneChat(); pruneEvents(); pruneShop(); }, 3600 * 1000).unref();
  setInterval(pushChoreReminders, +process.env.ROTA_PUSH_EVERY || 5 * 60 * 1000).unref();
  setInterval(() => speakOverdue().catch(e => console.error(e)), +process.env.ROTA_SPEAK_EVERY || 5 * 60 * 1000).unref();
  setInterval(() => tvReminders().catch(e => console.error(e)), +process.env.ROTA_TV_EVERY || 5 * 60 * 1000).unref();
  setInterval(() => tvDaily().catch(e => console.error(e)), +process.env.ROTA_TV_EVERY || 5 * 60 * 1000).unref();
  if (!process.env.NO_HA_LISTENER) setTimeout(startHaListener, 2000);
  if (SPEAKERS.size) console.log(`Spoken reminders on: ${[...SPEAKERS].map(([n, e]) => `${n} → ${e}`).join(', ')}`);
  setInterval(backup, 6 * 3600 * 1000).unref();
  setInterval(() => { pruneSessions(); save(); }, 3600 * 1000).unref();
  setInterval(() => { for (const c of streams) c.res.write(': ping\n\n'); }, 25000).unref();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true, version: VERSION });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
      res.writeHead(405); res.end();
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e.status) return fail(res, e.status, e.status === 413 ? 'That was too large to save.' : "That request couldn't be read.");
      console.error(e); fail(res, 500, 'Something went wrong on the server.');
    }
  });
  server.listen(PORT, HOST, () => {
    console.log(`Family Planner listening on http://${HOST}:${PORT}`);
    if (!Object.keys(db.logins).length) console.log('No accounts yet. Create one with: node server.js add-admin <email> "<your name>"');
  });
  const stop = () => { if (saveTimer) saveNow(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
const args = process.argv.slice(2);
if (args.length) cli(args).catch(e => { console.error(e.message); process.exit(1); }); else start();
