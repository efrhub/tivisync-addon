/* ---------- dates: plain YYYY-MM-DD strings, calculated in UTC so clocks changing can't shift a day ---------- */
const DAY = 864e5;
const toD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toS = d => d.toISOString().slice(0, 10);
const localToday = () => { const n = new Date(); return toS(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()))); };
const addDays = (s, n) => toS(new Date(toD(s).getTime() + n * DAY));
const diffDays = (a, b) => Math.round((toD(a) - toD(b)) / DAY);
const mondayOf = s => addDays(s, -((toD(s).getUTCDay() + 6) % 7));
const fmt = (s, o) => toD(s).toLocaleDateString('en-GB', { timeZone: 'UTC', ...o });
const fmtShort = s => fmt(s, { weekday: 'short', day: 'numeric', month: 'short' });

function addInterval(s, n, unit, dom) {
  if (unit === 'day') return addDays(s, n);
  if (unit === 'week') return addDays(s, n * 7);
  const d = toD(s), months = unit === 'year' ? n * 12 : n;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, want = dom || d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toS(new Date(Date.UTC(y, m, Math.min(want, last))));
}
const step = (c, s) => addInterval(s, c.every || 1, c.unit, c.dom);

/* When a chore is done: "fixed" stays on its calendar pattern, "floating" counts from the day it was done. */
function nextDue(c, today) {
  if (c.unit === 'once') return null;
  if (c.basis !== 'fixed') return step(c, today);
  let cur = c.sched || c.due, guard = 0;
  do { cur = step(c, cur); } while ((cur <= today || cur <= c.due) && guard++ < 5000);
  return cur;
}
function occurrences(c, start, end, today) {
  if (c.done || !c.due) return [];
  const out = [];
  if (c.due < today) { if (today >= start && today <= end) out.push({ date: today, late: true }); }
  else if (c.due >= start && c.due <= end) out.push({ date: c.due });
  if (c.unit === 'once') return out;
  let cur = c.due < today ? nextDue(c, today) : nextDue(c, c.due), guard = 0;
  while (cur && cur <= end && guard++ < 400) { if (cur >= start) out.push({ date: cur }); cur = step(c, cur); }
  return out;
}
function streaks(dates, today) {
  const days = [...new Set(dates)].sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) { run = prev && diffDays(d, prev) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  let current = 0;
  if (prev && diffDays(today, prev) <= 1) { current = 1; let i = days.length - 1; while (i > 0 && diffDays(days[i], days[i - 1]) === 1) { current++; i--; } }
  return { current, best };
}
const fmtMins = m => { m = Math.round(m); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}` : `${h}h`; };
const perMonth = c => { if (c.unit === 'once' || c.done) return 0; const d = { day: 1, week: 7, month: 30.44, year: 365.25 }[c.unit] * (c.every || 1); return (c.minutes || 0) * 30.44 / d; };
function repeatText(c) {
  if (c.unit === 'once') return "One-off";
  const n = c.every || 1, plural = { day: 'days', week: 'weeks', month: 'months', year: 'years' }[c.unit];
  if (n === 1) return { day: 'Every day', week: 'Every week', month: 'Every month', year: 'Every year' }[c.unit];
  return `Every ${n} ${plural}`;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- starter routines ---------- */
const T = (title, every, unit, minutes, kind) => ({ title, every, unit, minutes, kind: kind || 'chore' });
const ROOM_TEMPLATES = {
  'Kitchen': [T('Wipe worktops and hob', 1, 'day', 5), T('Empty the dishwasher', 1, 'day', 5), T('Wash tea towels', 1, 'week', 5), T('Mop the floor', 1, 'week', 15), T('Clean the microwave', 2, 'week', 10), T('Clear out the fridge', 1, 'month', 20), T('Descale the kettle', 1, 'month', 5), T('Clean the oven', 3, 'month', 45), T('Defrost the freezer', 6, 'month', 40)],
  'Bathroom': [T('Clean the toilet', 1, 'week', 10), T('Clean sink and mirror', 1, 'week', 10), T('Clean shower and bath', 1, 'week', 15), T('Wash the towels', 1, 'week', 5), T('Descale the shower head', 3, 'month', 15)],
  'Living room': [T('Hoover the living room', 1, 'week', 15), T('Dust the surfaces', 1, 'week', 10), T('Wash cushion covers', 3, 'month', 20)],
  'Bedroom': [T('Hoover the bedroom', 1, 'week', 10), T('Change the bed sheets', 2, 'week', 15), T('Turn the mattress', 6, 'month', 10)],
  'Hallway and stairs': [T('Hoover hall and stairs', 1, 'week', 10), T('Shake out the doormat', 1, 'month', 5), T('Dust the skirting boards', 2, 'month', 25)],
  'Utility': [T('Clear the dryer lint', 1, 'week', 2), T('Clean the washing machine filter', 1, 'month', 10)],
  'Home office': [T('Wipe down the desk', 1, 'week', 5), T('Empty the paper bin', 1, 'week', 2)],
  'Garden': [T('Mow the lawn', 2, 'week', 30), T('Sweep the patio', 1, 'month', 20), T('Clear the gutters', 6, 'month', 60)],
};
const HOUSE = [T('Put the bins out', 1, 'week', 5, 'reminder'), T('Test the smoke alarms', 1, 'month', 5, 'reminder'), T('Bleed the radiators', 1, 'year', 30), T('Book the boiler service', 1, 'year', 5, 'reminder')];
const PETS = [T('Clean the litter tray', 1, 'day', 5), T('Wash the pet bed', 1, 'month', 10), T('Flea and worm treatment', 1, 'month', 5, 'reminder')];
const KIDS = [T('Tidy the toys', 1, 'day', 10), T('Wash the school uniform', 1, 'week', 15), T('Sort outgrown clothes', 3, 'month', 30)];

function buildHome(o, today) {
  const roomNames = [...o.rooms, 'Whole house'];
  const rooms = roomNames.map((name, i) => ({ id: 'r' + uid() + i, name, order: i }));
  const people = o.people || [];
  const chores = []; let i = 0;
  for (const room of rooms) {
    const list = room.name === 'Whole house' ? [...HOUSE, ...(o.pets ? PETS : []), ...(o.kids ? KIDS : [])] : ROOM_TEMPLATES[room.name] || [];
    for (const t of list) {
      const offset = t.unit === 'day' ? 0 : t.unit === 'week' ? (t.every * 7 > 7 ? i % 14 : i % 7) : t.unit === 'month' ? (i * 3) % 28 + 3 : 30 + (i * 7) % 60;
      const due = addDays(today, offset);
      chores.push({ id: 'c' + uid() + i, title: t.title, kind: t.kind, roomId: room.id, every: t.every, unit: t.unit, minutes: t.minutes, due,
        basis: (t.unit === 'day' || t.unit === 'week') ? 'fixed' : 'floating', dom: t.unit === 'month' || t.unit === 'year' ? toD(due).getUTCDate() : null,
        assignee: people.length > 1 ? people[i % people.length] : '', rotate: false, notes: '', done: false, created: today });
      i++;
    }
  }
  return { rooms, chores };
}

/* ---------- store: the server is the record, and every open device gets changes live ---------- */
const S = { rooms: new Map(), chores: new Map(), members: new Map(), log: new Map(), meta: new Map(), schedules: new Map(), holidays: new Map(), work: new Map(), away: new Map(), events: new Map(), dinners: new Map(), outings: new Map(), awayReasons: new Map(), deviceAsks: new Map(), dinnerTasks: new Map(), nights: new Map(), nightTypes: new Map(), shop: new Map(), trips: new Map(), reviews: new Map(), chat: new Map(), shifts: new Map() };
const COLLS = ['rooms', 'chores', 'members', 'log', 'meta', 'schedules', 'holidays', 'work', 'away', 'outings', 'awayReasons', 'deviceAsks', 'events', 'dinners', 'dinnerTasks', 'nights', 'nightTypes', 'shop', 'trips', 'reviews', 'chat', 'shifts'];
const GROUPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
let ready = false, signedOut = false, slowNote = false, me = null, logins = {}, withSignIn = [], everyoneIds = [], levels = {}, birthdays = {}, lastDoneInfo = {}, sick = {}, nightGroups = [], changes = [], stream = null, appVersion = '', newVersion = '', reminder = null, reminderTimer = null;
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('rota-' + k); localStorage.setItem('rota-' + k, v); } catch (e) { return null; } };
let who = pref('who') || 'all', weekStart = null;

async function call(method, url, body) {
  const res = await fetch('api/' + url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Rota': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== 'login') { showSignedOut(); }
  if (!res.ok) throw Object.assign(new Error(data.error || "That didn't work. Check your connection and try again."), { status: res.status });
  return data;
}
function writeFailed(e) { toast(e.message); refresh(); }
async function put(coll, obj) {
  S[coll].set(obj.id, obj); scheduleRender();
  const { id, ...body } = obj;
  try { await call('PUT', `d/${coll}/${encodeURIComponent(id)}`, body); } catch (e) { writeFailed(e); }
}
async function del(coll, id) {
  S[coll].delete(id); scheduleRender();
  try { await call('DELETE', `d/${coll}/${encodeURIComponent(id)}`); } catch (e) { writeFailed(e); }
}
function applyState(st) {
  for (const c of COLLS) S[c] = new Map(Object.entries(st[c] || {}).map(([id, d]) => [id, { id, ...d }]));
  me = st.me; logins = st.logins || {}; withSignIn = st.withSignIn || []; everyoneIds = st.everyoneIds || []; levels = st.levels || levels; birthdays = st.birthdays || {}; nightGroups = st.nightGroups || []; sick = st.sick || {}; lastDoneInfo = st.lastDone || {}; changes = st.changes || [];
  if (!pushInfo) setTimeout(loadPush);
  if (st.version) { if (!appVersion) appVersion = st.version; else if (st.version !== appVersion) newVersion = st.version; }
  queueReminders();
  if (who !== 'all' && (!S.members.has(who) || !me.admin)) who = 'all';
  ready = true; signedOut = false; slowNote = false;
  scheduleRender();
}
/* Admins see when a chore is done, unless they are at school, at work or away. */
async function choreDoneAlert(l) {
  if (!me || !me.admin || l.actor === me.id || document.hidden) return;
  try { reminder = await call('GET', 'reminders'); } catch (e) { /* use the last answer */ }
  if (reminder && reminder.busy) return;
  toast(l.extra ? `${memberName(l.by) || 'Someone'} did an extra job: ${l.title}.` : `${memberName(l.by) || 'Someone'} has done ${l.title}.`);
}
async function refresh() {
  try { applyState(await call('GET', 'state')); connectStream(); }
  catch (e) { if (e.status !== 401) { slowNote = true; scheduleRender(); } }
}
function connectStream() {
  if (stream) return;
  stream = new EventSource('api/events');
  let dropped = false;
  stream.onopen = () => { if (dropped) { dropped = false; refresh(); } else if (slowNote) { slowNote = false; scheduleRender(); } };
  stream.onerror = () => {
    dropped = true;
    if (stream && stream.readyState === EventSource.CLOSED) { stream = null; setTimeout(refresh, 3000); }
  };
  stream.onmessage = ev => {
    const e = JSON.parse(ev.data);
    if (e.coll === 'logins' || (e.coll === 'log' && me && !me.admin && (!e.doc || e.doc.rejected))) return refresh();
    if (!COLLS.includes(e.coll)) return;
    const fresh = e.coll === 'chat' && e.doc && !S.chat.has(e.id);
    const newlyDone = e.coll === 'log' && e.doc && !e.doc.rejected && !S.log.has(e.id);
    if (e.doc) S[e.coll].set(e.id, { id: e.id, ...e.doc }); else S[e.coll].delete(e.id);
    if (newlyDone) choreDoneAlert(e.doc);
    if (e.coll === 'reviews' && e.doc && me && me.admin) toast(`${e.doc.name} has redone ${e.doc.title}. Check it on Today.`);
    if (fresh) newChatMessage(e.id);
    if (['chores', 'log', 'away', 'work', 'schedules', 'holidays'].includes(e.coll)) queueReminders();
    if (e.coll === 'members' && me && e.id === me.id && !e.doc) return refresh();
    scheduleRender();
  };
}
function queueReminders() {
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(async () => {
    if (!me) return;
    try { reminder = await call('GET', 'reminders'); scheduleRender(); } catch (e) { /* tried again on the next change */ }
  }, 400);
}
function showSignedOut() {
  if (stream) { stream.close(); stream = null; }
  me = null; signedOut = true; ready = true;
  if (typeof closeSheet === 'function') closeSheet();
  scheduleRender();
}

/* ---------- derived ---------- */
const rooms = () => [...S.rooms.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const members = () => [...S.members.values()].sort((a, b) => a.name.localeCompare(b.name));
const allChores = () => [...S.chores.values()].filter(c => !c.done);
const roomName = id => S.rooms.get(id)?.name || 'No room';
const memberName = id => S.members.get(id)?.name || '';
const logs = () => [...S.log.values()].filter(l => !l.rejected).sort((a, b) => (b.stamp || 0) - (a.stamp || 0));
/* The server also sends a night away to the person covering it, so chores land correctly. Only the person away and admins see it listed. */
const listedAway = () => [...S.away.values()].filter(a => me.admin || a.memberId === me.id);
const awayOn = (id, date) => [...S.away.values()].find(a => a.memberId === id && a.from <= date && a.to >= date);
const tripOn = date => [...S.trips.values()].find(t => t.from <= date && t.to >= date);
function afterTrips(date) { let d = date, t; for (let i = 0; i < 60 && (t = tripOn(d)); i++) d = addDays(t.to, 1); return d; }
/* With a chore time, a timed night away only takes chores after they leave and before they're back. */
/* Out and back on one day, such as an evening out. Otherwise they're back the morning after. */
const sameDayAway = a => a.allDay === false && a.from === a.to && a.back > a.leave;
const awayReason = a => a.reason || 'Out for the night';
const choreAway = (id, date, time) => [...S.away.values()].find(a => a.memberId === id && (sameDayAway(a) ? !!time && date === a.from && time >= a.leave && time < a.back : time && a.allDay === false
  ? (date > a.from && date <= a.to) || (date === a.from && time >= a.leave) || (date === addDays(a.to, 1) && time < a.back)
  : a.from <= date && a.to >= date));
/* Where one occurrence of a chore lands, after a one-off move, a second person or a night away. */
function isBirthday(id, date) {
  const md = birthdays[id]; if (!md) return false;
  const t = date.slice(5), y = +date.slice(0, 4);
  return md === t || (md === '02-29' && t === '02-28' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)));
}
const isOff = (id, date, time) => !!choreAway(id, date, time) || isBirthday(id, date);
function otherOnLevel(id, date, time, level) {
  /* For a chore with no group, anyone who shares a group with this person can cover. */
  const ids = level ? levels[level] || [] : [...new Set(GROUPS.filter(n => (levels[n] || []).includes(id)).flatMap(n => levels[n]))].sort((a, b) => memberName(a).localeCompare(memberName(b)));
  const from = ids.indexOf(id);
  for (let i = 1; i <= ids.length; i++) { const o = ids[(from + i + ids.length) % ids.length]; if (o !== id && !isOff(o, date, time)) return o; }
  return '';
}
function placeOn(c, date) {
  if (tripOn(date)) return placeOn(c.once && c.once.date === date ? { ...c, once: { ...c.once, date: afterTrips(date) } } : c, afterTrips(date));
  if (c.once && c.once.date === date) return { date, who: c.once.assignee };
  const main = c.assignee || '';
  if (!main || !isOff(main, date, c.time)) return { date, who: main };
  const away = choreAway(main, date, c.time), birthday = isBirthday(main, date);
  const cover = [c.backup, c.backupGroup ? otherOnLevel(main, date, c.time, c.backupGroup) : '', away && away.coverId, (birthday || c.level) ? otherOnLevel(main, date, c.time, c.level) : ''].find(p => p && p !== main && S.members.has(p) && !isOff(p, date, c.time));
  if (cover) return { date, who: cover };
  let d = date; for (let i = 0; i < 60 && isOff(main, d, c.time); i++) d = addDays(d, 1);
  return { date: d, who: main };
}
function effective(c) {
  const today0 = localToday(), start = tripOn(c.due) ? c.due : (c.due < today0 ? today0 : c.due);
  if (tripOn(start)) {
    const back = afterTrips(start);
    return { ...effective({ ...c, due: back, once: c.once && c.once.date === c.due ? { ...c.once, date: back } : c.once }), sched: c.sched || c.due, tripMoved: true };
  }
  const today = localToday(), main = c.assignee || '';
  /* A chore that fell on a night away stays moved or covered, even after that night has passed. */
  const base = (c.once && c.once.date === c.due) || (main && isOff(main, c.due, c.time)) ? c.due : (c.due < today ? today : c.due);
  const p = placeOn(c, base);
  const out = { ...c, assignee: p.who };
  if (p.who !== (c.assignee || '')) out.coverFor = c.assignee;
  if (p.date !== base) { out.due = p.date; out.sched = c.sched || c.due; out.moved = true; }
  return out;
}
const visible = () => allChores().map(effective).filter(c => {
  if (!me.admin) {
    if (isBirthday(me.id, localToday()) && c.due <= localToday() && c.assignee !== me.id) return false;
    if (c.anyLevel && !c.assignee) return (levels[c.anyLevel] || []).includes(me.id);
    return c.everyone ? !(c.doneBy || []).includes(me.id) : !c.assignee || c.assignee === me.id;
  }
  if (c.everyone) { const t = who === 'all' ? me.id : who; if (who !== 'all' && (c.people || []).length && !c.people.includes(who)) return false; return !(c.doneBy || []).includes(t); }
  return who === 'all' || !c.assignee || c.assignee === who;
});
const canTick = () => !!me && (me.cleaner || me.admin);
const clockTime = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const shiftDate = ms => { const d = new Date(ms); return toS(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); };
const shiftChores = s => { const live = logs().filter(l => l.shiftId === s.id).map(l => l.title); return live.length ? live : s.done || []; };
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dayNumber = date => ((toD(date).getUTCDay() + 6) % 7) + 1;
const holidays = () => [...S.holidays.values()].sort((a, b) => a.from < b.from ? -1 : 1);
const holidayFor = (date, id) => holidays().find(h => h.from <= date && h.to >= date && (!(h.people || []).length || h.people.includes(id)));
const workShifts = () => [...S.work.values()].sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : a.start < b.start ? 1 : -1);
const workMins = w => { const m = t => +t.slice(0, 2) * 60 + +t.slice(3); const d = m(w.end) - m(w.start); return d > 0 ? d : d + 1440; };
const workEnd = w => `${w.end}${w.end <= w.start ? ' next day' : ''}`;
function schoolDay(date, id) {
  if (tripOn(date)) return null;
  const sc = S.schedules.get(id), t = sc && sc.days && sc.days[dayNumber(date)];
  if (!t || holidayFor(date, id)) return null;
  return { place: sc.place, start: t.start, end: t.end };
}

/* ---------- actions ---------- */
function creditFor(c) { if (c.assignee && S.members.has(c.assignee) && !hasLogin(c.assignee)) return c.assignee; return me ? me.id : ''; }
const hasLogin = id => withSignIn.includes(id);
const undoCopies = new Map();
function openProof(id) {
  const c = S.chores.get(id); if (!c) return;
  openSheet(`<form id="proof-form" data-id="${esc(id)}"><h2 id="sheet-title">Take a picture: ${esc(c.title)}</h2>
    <p class="hint">${esc(c.returned.by)} asked for a picture of the finished job${c.returned.note ? `: ${esc(c.returned.note)}` : ''}.</p>
    <div class="field"><label class="lab" for="pf-photo">Picture</label><input type="file" id="pf-photo" accept="image/*" capture="environment" required></div>
    <p class="form-error" id="pf-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary" id="pf-go">Send and tick off</button></div></form>`);
}
/* An admin ticking a job everyone does picks whose turn it was, so it doesn't vanish for the rest of the house. */
function openEveryoneTick(c, waiting) {
  openSheet(`<form id="everyone-tick" data-id="${esc(c.id)}"><h2 id="sheet-title">Who did ${esc(c.title)}?</h2>
    <p class="hint">Everyone has their own turn at this job. It stays on everyone else's list until they've done it too.</p>
    ${waiting.length ? `<div class="pills" style="margin:12px 0">${waiting.map(id => `<button type="button" class="pill" data-a="done-for" data-id="${esc(c.id)}" data-who="${esc(id)}">${esc(memberName(id))}</button>`).join('')}</div>` : ''}
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button type="button" class="btn" data-a="done-for" data-id="${esc(c.id)}" data-who="__all">Done for everyone</button></div></form>`);
}
const everyoneWaiting = (c, doneBy) => {
  const today = localToday(), required = (c.people || []).length ? c.people : everyoneIds;
  return required.filter(id => everyoneIds.includes(id) || (c.people || []).includes(id)).filter(id => S.members.has(id) && !doneBy.includes(id) && !awayOn(id, c.due < today ? today : c.due));
};
async function complete(id, proof, forWho) {
  const c = S.chores.get(id); if (!c) return;
  if (c.returned && c.returned.needPhoto && !me.admin && !proof) return openProof(id);
  const today = localToday();
  const entry = { id: 'l' + uid(), actor: me ? me.id : '', ...(proof ? { proof } : {}), choreId: c.id, title: c.title, roomId: c.roomId, by: creditFor(c), date: today, minutes: c.minutes || 0, stamp: Date.now(), prevDue: c.due, prevSched: c.sched || null, prevAssignee: c.assignee || '' };
  entryEveryone: if (c.everyone) {
    entry.prevDoneBy = c.doneBy || [];
    let person = me.id;
    if (me.admin) {
      const left = everyoneWaiting(c, c.doneBy || []);
      if (forWho === '__all') break entryEveryone;
      if (forWho) person = forWho;
      else if (who !== 'all' && left.includes(who)) person = who;
      else if (left.includes(me.id)) person = me.id;
      else return openEveryoneTick(c, left);
      entry.by = person;
    }
    const doneBy = [...new Set([...(c.doneBy || []), person])];
    const waiting = everyoneWaiting(c, doneBy);
    if (!waiting.length) break entryEveryone;
    toast(`${c.title} done${person !== me.id ? ` for ${memberName(person)}` : ''}. ${waiting.length} more to do it.`, () => undoLog(entry.id));
    await put('log', entry);
    const mineDone = { ...c, doneBy }; delete mineDone.returned; delete mineDone.delay;
    await put('chores', mineDone);
    return;
  }
  const next = { ...c, lastDone: today };
  delete next.sched; delete next.once; delete next.doneBy; delete next.returned; delete next.delay;
  const due = nextDue(c, today);
  if (due) next.due = due; else next.done = true;
  if (c.level) { const m = levels[c.level] || []; if (m.length) next.assignee = m[(m.indexOf(c.assignee) + 1) % m.length]; }
  else if (c.rotate && c.assignee) { const m = members(); const i = m.findIndex(x => x.id === c.assignee); if (m.length > 1 && i >= 0) next.assignee = m[(i + 1) % m.length].id; }
  if (proof) toast(`${c.title} sent to be checked.`);
  else toast(due ? `${c.title} done. Next: ${fmtShort(due)}` : `${c.title} done.`, () => undoLog(entry.id));
  undoCopies.set(entry.id, next);
  await put('log', entry);
  await put('chores', next);
}
async function undoLog(id) {
  const e = S.log.get(id); if (!e) return;
  const c = S.chores.get(e.choreId) || undoCopies.get(id);
  await del('log', id);
  if (c) { const back = { ...c, due: e.prevDue, done: false, assignee: e.prevAssignee }; if (e.prevSched) back.sched = e.prevSched; else delete back.sched; if (e.prevDoneBy) { if (e.prevDoneBy.length) back.doneBy = e.prevDoneBy; else delete back.doneBy; } await put('chores', back); }
  toast('Undone.');
}
function delayOpen(id) {
  const c = S.chores.get(id);
  openSheet(`<form id="delay-form" data-id="${esc(id)}"><h2 id="sheet-title">Why are you delaying this?</h2><p class="hint">${esc(c ? c.title : 'This chore')} will move back 30 minutes.</p>
    <div class="field"><label class="lab" for="dl-why">Reason</label><textarea id="dl-why" required maxlength="200" rows="3"></textarea></div>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Delay 30 min</button></div></form>`);
  document.getElementById('dl-why').focus();
}
async function later(id, reason) {
  try {
    const r = await call('POST', `chores/${encodeURIComponent(id)}/delay`, { reason });
    const c = S.chores.get(id);
    toast(`${c ? c.title : 'Chore'} delayed until ${clockTime(r.until)}.`);
  } catch (e) { writeFailed(e); }
}
async function skip(id) {
  const c = S.chores.get(id); if (!c || c.unit === 'once') return;
  const today = localToday(); const base = c.due > today ? c.due : today;
  const next = { ...c, due: nextDue(c, base) }; delete next.sched; delete next.once; delete next.doneBy; delete next.delay;
  await put('chores', next);
  call('POST', `chores/${encodeURIComponent(id)}/skipped`, { title: c.title }).catch(() => {});
  toast(`${c.title} skipped. Next: ${fmtShort(next.due)}`, () => put('chores', c));
}

/* ---------- rendering ---------- */
let renderQueued = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
const main = document.getElementById('main');
/* In cleaner mode there's no System tab; switching to Admin mode brings it back. */
const showSystem = () => !!(me && me.system && !(me.canSwitch && me.mode === 'cleaner'));
function scheduleNav(page) {
  const link = (id, label) => `<a class="pill" href="#${id}" data-sub="${id}" ${page === id ? 'aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="pills sub-nav" aria-label="Schedule">${link('school', 'Schedule')}${link('dinner', 'Dinner')}${link('fun', 'Entertainment')}</nav>`;
}
const tabName = () => { const h = location.hash.slice(1); if (h === 'system' && !showSystem()) return 'today'; if (h === 'logs' && !(me && me.admin)) return 'today'; return ['today', 'week', 'rooms', 'progress', 'school', 'dinner', 'fun', 'extra', 'chat', 'shop', 'logs', 'system'].includes(h) ? h : 'today'; };
const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';

function render() {
  const active = document.activeElement;
  /* Keep what someone is typing, and still show new messages as they arrive. */
  if (active && active.id === 'chat-text') { updateChatBadge(); refreshChatList(); return; }
  if (active && active.id === 'shop-text') { const l = document.getElementById('shop-list'); if (l) l.innerHTML = shopRows(); return; }
  if (active && main.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) { active.addEventListener('blur', scheduleRender, { once: true }); return; }
  const focusKey = active && active.dataset ? active.dataset.fk : null;
  const authed = !signedOut && !!me;
  document.getElementById('nav').hidden = !authed;
  document.getElementById('add-btn').hidden = !authed || !me.admin || tabName() !== 'school';
  document.body.classList.toggle('not-admin', !me || !me.admin);
  document.querySelector('[data-tab="system"]').hidden = !showSystem();
  document.querySelector('[data-tab="logs"]').hidden = !(me && me.admin);
  document.querySelector('[data-tab="chat"]').hidden = !authed;
  document.querySelector('[data-tab="shop"]').hidden = !authed;
  document.querySelector('[data-tab="extra"]').hidden = !(authed && (me.cleaner || me.admin));
  document.getElementById('whats-new').hidden = !authed;
  const sw = document.getElementById('mode-switch');
  sw.hidden = !(authed && me.canSwitch);
  if (authed && me.canSwitch) sw.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.id === me.mode));
  updateChatBadge();
  if (signedOut) { main.innerHTML = signInHTML(); loadWhatsOn(); return; }
  const tab = tabName();
  document.querySelectorAll('#tabs a').forEach(a => { if (a.dataset.tab === (['dinner', 'fun'].includes(tab) ? 'school' : tab)) { if (a.getAttribute('aria-current') !== 'page') { const t = document.getElementById('tabs'); t.scrollLeft = a.offsetLeft - t.offsetLeft - (t.clientWidth - a.offsetWidth) / 2; } a.setAttribute('aria-current', 'page'); } else a.removeAttribute('aria-current'); });
  if (tab === 'chat') markChatRead();
  const empty = !S.rooms.size && !S.chores.size;
  if (empty) document.getElementById('add-btn').hidden = true;
  if (!ready && empty) { main.innerHTML = `<div class="empty">${slowNote ? "Can't reach the server. Your planner will appear as soon as the connection returns." : 'Loading your planner…'}</div>`; return; }
  const choreTab = ['today', 'week', 'rooms'].includes(tab);
  if (choreTab && empty) { main.innerHTML = me.admin ? setupHTML(true) : `<div class="empty">Your household admin hasn't set up the planner yet.</div>`; return; }
  main.innerHTML = banners() + ({ today: viewToday, week: viewWeek, rooms: viewRooms, progress: viewProgress, school: viewSchool, dinner: viewDinner, fun: viewFun, extra: viewExtra, chat: viewChat, shop: viewShop, logs: viewLogs, system: viewSystem }[tab])();
  if (focusKey) main.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus();
}
function banners() {
  let h = '';
  if (slowNote) h += `<div class="notice"><span>Can't reach the server right now. What you see may be out of date.</span></div>`;
  if (newVersion) h += `<div class="notice update-bar"><span><b>A new version is ready.</b> Update when you've finished what you're doing.</span><button class="btn small primary" data-a="app-update">Update</button></div>`;
  if (me && !me.admin && isBirthday(me.id, localToday())) h += '<div class="notice clocked"><span><b>Happy birthday!</b> You have no jobs today.</span></div>';
  if (me && me.admin && S.reviews.size && tabName() !== 'today') h += `<div class="notice"><span><b>${S.reviews.size} redone ${S.reviews.size === 1 ? 'chore' : 'chores'}</b> waiting for your check.</span><a class="btn small" href="#today">Check now</a></div>`;
  if (me && sickUntil(me.id)) h += `<div class="notice clocked"><span><b>Get well soon.</b> Your chores are paused until ${esc(stampText(sickUntil(me.id)))}.</span></div>`;
  { const waiting = me && me.admin ? [...S.deviceAsks.values()].filter(q => !q.answer).length : 0;
    if (waiting && tabName() !== 'extra') h += `<div class="notice ask-notice"><span><b>${waiting} ${waiting === 1 ? 'request' : 'requests'} for extra time</b> waiting for an answer.</span><a class="btn small" href="#extra">See</a></div>`; }
  h += dinnerBanner();
  const trip = me && tripOn(localToday());
  if (trip) h += `<div class="notice trip"><span><b>Family holiday: ${esc(trip.name)}.</b> No schedule or alerts until you're back on ${esc(fmtShort(afterTrips(localToday())))}.</span></div>`;
  h += reminderHTML();
  return h;
}
function reminderHTML() {
  if (!me || !reminder) return '';
  const mine = reminder.late + reminder.today;
  const parts = [];
  if (mine) parts.push(`<div class="notice remind"><span><b>${mine} ${mine === 1 ? 'chore' : 'chores'} not done.</b>${reminder.late ? ` ${reminder.late} ${reminder.late === 1 ? 'is' : 'are'} late.` : ''}</span><span class="pills"><a class="btn small" href="#today">See chores</a><button class="btn small" data-a="remind-snooze" data-id="mine">Snooze 1 hour</button></span></div>`);
  const o = reminder.others;
  if (me.admin && o.length) parts.push(`<div class="notice remind"><span><b>Not done by others:</b> ${o.slice(0, 4).map(x => `${esc(x.title)} (${x.who ? esc(x.who) + ', ' : ''}${x.days} ${x.days === 1 ? 'day' : 'days'} late)`).join(', ')}${o.length > 4 ? `, and ${o.length - 4} more` : ''}</span><button class="btn small" data-a="remind-snooze" data-id="others">Snooze 1 hour</button></div>`);
  return parts.join('');
}
function eventDateFrom(e, from) {
  if (e.unit === 'once') return e.date >= from ? e.date : null;
  let d = e.date;
  for (let i = 0; d < from && i < 5000; i++) d = addInterval(d, e.every || 1, e.unit, toD(e.date).getUTCDate());
  return d;
}
const upcomingEvents = today => [...S.events.values(), ...linkedEvents()].map(e => ({ e, when: eventDateFrom(e, today) })).filter(x => x.when).sort((a, b) => a.when < b.when ? -1 : a.when > b.when ? 1 : (a.e.time || '').localeCompare(b.e.time || ''));
function openEvent(e) {
  const canEdit = !e.id || me.admin || e.createdBy === me.id, today = localToday();
  if (!canEdit) return openSheet(`<div><h2 id="sheet-title">${esc(e.title)}</h2><p class="row-meta">${esc(fmtShort(eventDateFrom(e, today) || e.date))}${e.time ? `, ${esc(e.time)}` : ''}</p>${e.notes ? `<p style="white-space:pre-wrap">${esc(e.notes)}</p>` : ''}<div class="actions"><button type="button" class="btn" data-a="close">Close</button></div></div>`);
  openSheet(`<form id="event-form" data-id="${esc(e.id || '')}"><h2 id="sheet-title">${e.id ? 'Edit reminder' : 'New reminder'}</h2>
    <div class="field"><label class="lab" for="ev-title">What is it?</label><input type="text" id="ev-title" required maxlength="120" placeholder="Dentist, day out, holiday" value="${esc(e.title || '')}" autocomplete="off"></div>
    <div class="two"><div class="field"><label class="lab" for="ev-date">Date</label><input type="date" id="ev-date" required value="${esc(e.date || today)}"></div>
    <div class="field"><label class="lab" for="ev-time">Time (optional)</label><input type="time" id="ev-time" value="${esc(e.time || '')}"></div></div>
    <div class="field"><label class="lab" for="ev-unit">Repeats</label><select id="ev-unit">${[['once', "Doesn't repeat"], ['day', 'Every day'], ['week', 'Every week'], ['month', 'Every month'], ['year', 'Every year']].map(([v, l]) => `<option value="${v}" ${(e.unit || 'once') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${me.admin ? `<fieldset><legend>Who it's for</legend><div class="checks">${members().map(m => `<label class="check"><input type="checkbox" name="ev-person" value="${esc(m.id)}" ${(e.people || []).includes(m.id) ? 'checked' : ''}><span>${esc(m.name)}</span></label>`).join('')}</div><div class="hint">Leave these unticked to show it to everyone.</div></fieldset>` : '<p class="hint">Only you and your admins can see this.</p>'}
    <div class="field"><label class="lab" for="ev-notes">Notes</label><textarea id="ev-notes" rows="2" maxlength="500">${esc(e.notes || '')}</textarea></div>
    <p class="form-error" id="ev-error" role="alert" hidden></p>
    <div class="actions">${e.id ? `<span class="left"><button type="button" class="btn danger" data-a="event-del-ask" data-id="${esc(e.id)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
/* "Are you still cleaning?" */
const sickUntil = id => (sick[id] && sick[id].until > Date.now() ? sick[id].until : 0);
function openSick() {
  openSheet(`<form id="sick-form"><h2 id="sheet-title">Log someone sick</h2><p class="hint">Their chores pause for 12 hours, with no reminders or alerts. Other people can't see this, only admins and the person who is sick.</p>
    <div class="field"><label class="lab" for="sk-who">Who is sick?</label><select id="sk-who" required><option value="">Choose a person</option>${members().filter(m => !sickUntil(m.id)).map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div>
    <p class="form-error" id="sk-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Pause chores</button></div></form>`);
}
function peopleFilter() {
  const m = members(); if (!m.length || !me.admin) return '';
  return `<div><span class="filter-label">Whose chores</span><div class="pills">
    <button class="pill" data-a="who" data-id="all" data-fk="who-all" aria-pressed="${who === 'all'}">Everyone</button>
    ${m.map(x => `<button class="pill" data-a="who" data-id="${esc(x.id)}" data-fk="who-${esc(x.id)}" aria-pressed="${who === x.id}">${esc(x.name)}</button>`).join('')}
  </div></div>`;
}
function row(c, today) {
  const late = c.due < today, days = diffDays(today, c.due);
  const when = late ? `<span class="when-late">${days === 1 ? 'Yesterday' : days + ' days late'}</span> · ` : c.due > today ? `${esc(fmtShort(c.due))} · ` : '';
  const a = memberName(c.assignee);
  const ticks = canTick();
  return `<li class="row">${ticks ? `<button class="tick" data-a="done" data-id="${esc(c.id)}" data-fk="t-${esc(c.id)}" aria-label="Mark ${esc(c.title)} as done">${TICK}</button>` : ''}
    <button class="row-main" data-a="edit" data-id="${esc(c.id)}"><span class="row-title">${esc(c.title)}${me.admin && c.assignee && sickUntil(c.assignee) ? '<span class="flag">Paused, off sick</span>' : ''}${c.coverFor ? `<span class="flag">Instead of ${esc(memberName(c.coverFor) || 'main person')}</span>` : ''}${c.moved ? '<span class="flag">Moved, away for the night</span>' : ''}${c.tripMoved ? '<span class="flag">After the family holiday</span>' : ''}${c.anyLevel && !c.assignee ? `<span class="flag">Anyone in: ${esc(levelNames(c.anyLevel) || 'nobody yet')}</span>` : ''}${c.level ? `<span class="flag">Takes turns: ${esc(levelNames(c.level) || 'nobody yet')}</span>` : ''}${c.returned ? `<span class="flag warn">Sent back${c.returned.needPhoto ? ': picture needed' : ''}</span>` : ''}${c.delay && c.delay.until > Date.now() ? `<span class="flag">Delayed until ${esc(clockTime(c.delay.until))}${c.delay.count > 1 ? `, ${c.delay.count} times` : ''}</span>` : ''}${c.everyone ? `<span class="flag">${(c.people || []).length ? esc(c.people.map(memberName).filter(Boolean).join(', ')) : 'Everyone'}${(c.doneBy || []).length ? `: ${c.doneBy.length} of ${Math.max((c.people || []).length || everyoneIds.length, c.doneBy.length)} done` : ''}</span>${me.admin && (c.doneBy || []).length ? `<span class="flag">Still to do: ${esc(everyoneWaiting(c, c.doneBy).map(memberName).filter(Boolean).join(', ') || 'nobody')}</span>` : ''}` : ''}</span>
    ${c.returned ? `<span class="row-note">${c.returned.note ? esc(c.returned.note) : 'See the photo.'} (${esc(c.returned.by)})</span>` : ''}<span class="row-meta">${when}${c.time ? `<b>${esc(c.time)}</b> · ` : ''}${esc(roomName(c.roomId))} · ${esc(fmtMins(c.minutes || 0))}${a ? ' · ' + esc(a) : ''}</span></button>
    ${me.admin ? `<button class="btn small" data-a="swap-open" data-id="${esc(c.id)}" aria-label="Swap ${esc(c.title)} to someone else">Swap</button>` : ''}
    ${c.returned && c.returned.photo ? `<button class="btn small" data-a="photo-view" data-id="${esc(c.returned.photo)}" aria-label="See the photo for ${esc(c.title)}">Photo</button>` : ''}
    ${ticks && !(c.everyone && !me.admin) ? `<button class="btn small later" data-a="later" data-id="${esc(c.id)}" aria-label="Delay ${esc(c.title)} by 30 minutes">Delay 30 min</button>` : ''}</li>`;
}
function openExtraJob() {
  openSheet(`<form id="extra-form"><h2 id="sheet-title">Add a job I did</h2><p class="hint">For something you did that wasn't on your list. An admin will be told.</p>
    <div class="field"><label class="lab" for="xj-text">What did you do?</label><input type="text" id="xj-text" required maxlength="120" placeholder="Cleaned the oven" autocomplete="off"></div>
    <div class="two"><div class="field"><label class="lab" for="xj-room">Room (optional)</label><select id="xj-room"><option value="">No room</option>${rooms().map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></div>
    <div class="field"><label class="lab" for="xj-mins">Took about</label><select id="xj-mins">${[5, 10, 15, 20, 30, 45, 60, 90, 120].map(n => `<option value="${n}" ${n === 15 ? 'selected' : ''}>${esc(fmtMins(n))}</option>`).join('')}</select></div></div>
    <p class="form-error" id="xj-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
  document.getElementById('xj-text').focus();
}
function reviewsHTML() {
  if (!me.admin || !S.reviews.size) return '';
  const list = [...S.reviews.values()].sort((a, b) => a.at - b.at);
  return `<section class="group reviews"><h2>Waiting for your check <small>${list.length}</small></h2><ul class="rows">${list.map(r => `<li class="review-row"><button class="review-pic" data-a="photo-view" data-id="${esc(r.photo)}" aria-label="See the picture of ${esc(r.title)}"><img src="api/photos/${encodeURIComponent(r.photo)}" alt=""></button>
    <div class="review-body"><b>${esc(r.title)}</b><span class="row-meta">${esc(memberName(r.memberId) || r.name)} · ${esc(stampText(r.at))}</span>${r.note ? `<span class="row-note">You said: ${esc(r.note)}</span>` : ''}
    <div class="pills"><button class="btn small primary" data-a="review-ok" data-id="${esc(r.id)}">That's OK</button><button class="btn small" data-a="review-no" data-id="${esc(r.id)}">Not good enough</button></div></div></li>`).join('')}</ul></section>`;
}
function openReviewReject(id) {
  const r = S.reviews.get(id); if (!r) return;
  openSheet(`<form id="review-form" data-id="${esc(id)}"><h2 id="sheet-title">Not good enough: ${esc(r.title)}</h2>
    <p class="hint">This puts it back where it was scheduled, posts it in Chat and asks for a new picture.</p>
    <div class="field"><label class="lab" for="rv-note">What still needs fixing?</label><textarea id="rv-note" rows="3" maxlength="500"></textarea></div>
    <div class="field"><label class="lab" for="rv-photo">Take a picture (optional)</label><input type="file" id="rv-photo" accept="image/*" capture="environment"><div class="hint">Without one, their picture is used.</div></div>
    <p class="form-error" id="rv-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary" id="rv-go">Send back again</button></div></form>`);
}
function viewToday() {
  const today = localToday();
  let list = visible();
  const doneToday = logs().filter(l => l.date === today && (who === 'all' || l.by === who || !l.by));
  const fullDue = list.filter(c => c.due <= today);
  const dueMin = fullDue.reduce((s, c) => s + (c.minutes || 0), 0);
  const listDone = doneToday.filter(l => !l.extra).length, total = fullDue.length + listDone, pct = total ? Math.round(listDone / total * 100) : 0;
  const by = (a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : (a.time || '99') < (b.time || '99') ? -1 : (a.time || '99') > (b.time || '99') ? 1 : a.title.localeCompare(b.title);
  const late = list.filter(c => c.due < today).sort(by);
  const now = list.filter(c => c.due === today).sort(by);
  const soon = list.filter(c => c.due > today && c.due <= addDays(today, 7)).sort(by);
  const sub = fullDue.length ? `${fullDue.length} to do, about ${fmtMins(dueMin)}` : total ? 'Everything due today is done.' : 'Nothing due today.';
  const next = allChores().filter(c => c.due > today).sort(by)[0];
  const group = (cls, title, note, items) => items.length ? `<section class="group ${cls}"><h2>${title} <small>${note}</small></h2><ul class="rows">${items.map(c => row(c, today)).join('')}</ul></section>` : '';
  return `<div class="layout"><div>
    <div class="hero"><h1>${esc(fmt(today, { weekday: 'long', day: 'numeric', month: 'long' }))}</h1><p>${sub}</p>
      <div class="towel" role="img" aria-label="${listDone} of ${total} done today"><span style="width:${pct}%"></span></div></div>
    <div class="filters">${peopleFilter()}</div>
    ${reviewsHTML()}
    ${group('late', 'Late', late.length + ' waiting', late)}
    ${group('', 'Today', now.length ? '' : '', now)}
    ${group('', 'Next 7 days', 'tick early if you get ahead', soon)}
    ${!late.length && !now.length && !soon.length ? `<div class="empty">Nothing in this view.${next ? ` Next up: ${esc(next.title)} on ${esc(fmtShort(next.due))}.` : ''}</div>` : ''}
    ${me.cleaner ? '<div class="extra-job"><button class="btn" data-a="extra-open">Add a job I did</button></div>' : ''}
    ${doneToday.length ? `<section class="group"><h2>Done today <small>${doneToday.length}</small></h2><ul class="rows">${doneToday.map(l => `<li class="row is-done"><span class="tick done" aria-hidden="true">${TICK}</span><span class="row-main" style="cursor:default"><span class="row-title">${esc(l.title)}${l.extra ? '<span class="flag">Extra job</span>' : ''}${l.pending ? '<span class="flag">Waiting for an adult to check</span>' : ''}</span><span class="row-meta">${l.roomId ? esc(roomName(l.roomId)) : ''}${l.roomId && memberName(l.by) ? ' · ' : ''}${esc(memberName(l.by))}${l.stamp ? `${l.roomId || memberName(l.by) ? ' · ' : ''}${esc(clockTime(l.stamp))}` : ''}${l.extra && l.minutes ? ` · about ${esc(fmtMins(l.minutes))}` : ''}</span></span>${me.admin && l.pending ? `<button class="btn small primary" data-a="job-check" data-id="${esc(l.id)}" data-yes="1">Approve</button><button class="btn small" data-a="job-check" data-id="${esc(l.id)}">Reject</button>` : ''}${me.admin && l.prevDue !== undefined && !l.proof && S.chores.has(l.choreId) ? `<button class="btn small" data-a="send-back" data-id="${esc(l.id)}" data-title="${esc(l.title)}">Not done properly</button>` : ''}${!l.proof && canTick() && (me.admin || (l.actor === me.id && (l.extra || S.chores.has(l.choreId) || undoCopies.has(l.id)))) ? `<button class="btn small" data-a="undo" data-id="${esc(l.id)}" aria-label="Undo ${esc(l.title)}">Undo</button>` : ''}</li>`).join('')}</ul></section>` : ''}
  </div>${sideToday(today)}</div>`;
}
const outingOn = (o, date) => o.weekly ? date >= o.from && diffDays(date, o.from) % 7 === 0 : date >= o.from && date <= o.to;
function whoIsOutHTML(date, isToday) {
  const before = addDays(date, -1), trip = tripOn(date);
  const rows = [
    ...workShifts().filter(w => w.date === before && w.end <= w.start).map(w => ({ who: memberName(w.memberId), what: 'Work', start: '', when: `Until ${w.end}` })),
    ...(trip ? [] : workShifts().filter(w => w.date === date)).map(w => ({ who: memberName(w.memberId), what: 'Work', start: w.start, when: `${w.start} to ${workEnd(w)}` })),
    ...members().map(m => ({ m, t: schoolDay(date, m.id) })).filter(x => x.t).map(x => ({ who: x.m.name, what: S.schedules.get(x.m.id)?.place || 'School', start: x.t.start, when: `${x.t.start} to ${x.t.end}` })),
    ...listedAway().filter(a => a.from <= date && a.to >= date).map(a => ({ awayId: a.id, who: memberName(a.memberId), what: awayReason(a), start: a.allDay === false && a.from === date ? a.leave : '', when: sameDayAway(a) ? `${a.leave} to ${a.back}` : a.allDay === false && a.from === date ? `From ${a.leave}` : 'All day' })),
    ...listedAway().filter(a => a.allDay === false && !sameDayAway(a) && addDays(a.to, 1) === date).map(a => ({ awayId: a.id, who: memberName(a.memberId), what: awayReason(a), start: '', when: `Until ${a.back}` })),
    ...(trip ? [] : [...S.outings.values()].filter(o => outingOn(o, date)).map(o => ({ id: o.id, who: memberName(o.memberId), what: o.activity, start: o.start, when: o.start ? `${o.start} to ${o.end}` : 'All day' }))),
  ].sort((a, b) => (a.start || '').localeCompare(b.start || '') || (a.who || '').localeCompare(b.who || ''));
  const row = r => { const inner = `<span class="out-who"><b>${esc(r.who || 'Someone')}</b> ${esc(r.what)}</span><span>${esc(r.when)}</span>`; return `<li>${r.id ? `<button class="out-row" data-a="out-open" data-id="${esc(r.id)}" aria-label="Change ${esc(r.what)}">${inner}</button>` : r.awayId && me.admin ? `<button class="out-row" data-a="away-open" data-id="${esc(r.awayId)}" aria-label="Change ${esc(r.what)}">${inner}</button>` : inner}</li>`; };
  const day = isToday ? 'today' : 'tomorrow';
  return `<div class="${isToday ? 'who-out' : 'who-out-next'}"><div class="card-head"><h3>Who is out ${day}</h3>${isToday ? '<button class="btn small" data-a="out-open">Add</button>' : ''}</div>${rows.length ? `<ul class="mini">${rows.map(row).join('')}</ul>` : `<p class="hint">${me.admin ? 'Nobody is out.' : `You aren't out ${day}.`}</p>`}</div>`;
}
const awayForm = a => ({ awayId: a.id, memberId: a.memberId, activity: awayReason(a), from: a.from, to: a.to, start: a.allDay === false ? a.leave : '', end: a.allDay === false ? a.back : '', handover: true });
function openOuting(o) {
  const today = localToday();
  const ideas = [...new Set([...[...S.awayReasons.values()].map(r => r.name), ...[...S.outings.values()].map(x => x.activity)])];
  openSheet(`<form id="out-form" data-id="${esc(o.id || '')}" data-away="${esc(o.awayId || '')}"><h2 id="sheet-title">${o.id || o.awayId ? 'Change activity' : 'Add an activity'}</h2>
    ${me.admin ? `<div class="field"><label class="lab" for="of-who">Who</label><select id="of-who">${members().map(m => `<option value="${esc(m.id)}" ${m.id === (o.memberId || me.id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label class="lab" for="of-what">Activity</label><input type="text" id="of-what" required maxlength="40" list="of-ideas" placeholder="Dance class" autocomplete="off" value="${esc(o.activity || '')}"><datalist id="of-ideas">${ideas.map(i => `<option value="${esc(i)}"></option>`).join('')}</datalist></div>
    <div class="two"><div class="field"><label class="lab" for="of-from">First day</label><input type="date" id="of-from" required value="${esc(o.from || today)}"></div><div class="field" id="of-to-wrap" ${o.weekly ? 'hidden' : ''}><label class="lab" for="of-to">Last day</label><input type="date" id="of-to" value="${esc(o.to || o.from || today)}"></div></div>
    <div class="two"><div class="field"><label class="lab" for="of-start">From</label><input type="time" id="of-start" value="${esc(o.start || '')}"></div><div class="field"><label class="lab" for="of-end">To</label><input type="time" id="of-end" value="${esc(o.end || '')}"></div></div>
    <p class="hint">Leave the times blank for all day.</p>
    <label class="inline-check" id="of-weekly-wrap" ${o.handover ? 'hidden' : ''}><input type="checkbox" id="of-weekly" ${o.weekly ? 'checked' : ''}> Every week on this day</label>
    ${me.admin ? `<label class="inline-check"><input type="checkbox" id="of-hand" ${o.handover ? 'checked' : ''}> Pass their chores on while they're out</label><p class="hint" id="of-hand-hint" ${o.handover ? '' : 'hidden'}>Each chore goes to its second person, and chores without one move to the next day. If the finish time is earlier than the start, they're back the morning after.</p>` : ''}
    <p class="form-error" id="of-error" role="alert" hidden></p>
    <div class="actions">${o.id ? `<span class="left"><button type="button" class="btn danger" data-a="out-del" data-id="${esc(o.id)}">Delete</button></span>` : o.awayId ? `<span class="left"><button type="button" class="btn danger" data-a="away-del-ask" data-id="${esc(o.awayId)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
function sideToday(today) {
  const s = streaks(logs().map(l => l.date), today);
  const week = mondayOf(today);
  const mins = logs().filter(l => l.date >= week).reduce((t, l) => t + (l.minutes || 0), 0);
  const rem = upcomingEvents(today).slice(0, 6);
  const onHoliday = holidays().filter(h => h.from <= today && h.to >= today);
  return `<aside>
    ${whoIsOutHTML(today, true)}
    ${whoIsOutHTML(addDays(today, 1), false)}
    ${onHoliday.length ? `<div><h3>School holiday</h3><ul class="mini">${onHoliday.map(h => `<li><span>${esc(h.name)}</span><span>${(h.people || []).length ? esc(h.people.map(memberName).filter(Boolean).join(', ')) : ''}</span></li>`).join('')}</ul></div>` : ''}
    <div class="stats"><div class="stat"><b>${s.current}</b><span>day streak</span></div><div class="stat"><b>${esc(fmtMins(mins).replace(' min', 'm'))}</b><span>this week</span></div></div>
    <div class="reminders"><div class="card-head"><h3>Reminders</h3><button class="btn small" data-a="event-open">New reminder</button></div>
      ${rem.length ? `<ul class="mini">${rem.map(x => `<li><button class="reminder-row ${x.when === today ? 'is-today' : ''}" data-a="event-open" data-id="${esc(x.e.id)}"><span>${esc(x.e.title)}</span><span>${x.when === today ? 'Today' : esc(fmt(x.when, { day: 'numeric', month: 'short' }))}${x.e.time ? ` ${esc(x.e.time)}` : ''}</span></button></li>`).join('')}</ul>` : '<p class="hint">Holidays, appointments, days out.</p>'}</div>
  </aside>`;
}
function viewWeek() {
  const today = localToday();
  const start = weekStart || mondayOf(today), end = addDays(start, 6);
  const items = {}; for (let i = 0; i < 7; i++) items[addDays(start, i)] = [];
  for (const c of visible()) for (const o of occurrences(c, start, end, today)) {
    let d = o.date, x = c;
    if (d !== c.due && !o.late) { const p = placeOn(S.chores.get(c.id), d); d = p.date; x = { ...c, assignee: p.who }; }
    if (items[d]) items[d].push({ c: x, late: o.late });
  }
  const done = {}; for (const l of logs()) if (l.date >= start && l.date <= end && (who === 'all' || l.by === who || !l.by)) (done[l.date] = done[l.date] || []).push(l);
  const label = `${fmt(start, { day: 'numeric', month: 'short' })} to ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  let total = 0;
  const days = Object.keys(items).map(d => {
    const list = items[d].sort((a, b) => (a.c.time || '99').localeCompare(b.c.time || '99') || a.c.title.localeCompare(b.c.title));
    const mins = list.reduce((s, x) => s + (x.c.minutes || 0), 0); total += mins;
    return `<div class="day ${d === today ? 'today' : ''}"><div class="day-head"><b>${esc(fmt(d, { weekday: 'short' }))} ${toD(d).getUTCDate()}</b><span>${mins ? esc(fmtMins(mins)) : ''}</span></div>
      ${weekEvents(d)}${weekSchool(d)}
      ${(done[d] || []).map(l => `<div class="chip done">${esc(l.title)}</div>`).join('')}
      ${list.map(x => `<button class="chip ${x.late ? 'late' : ''}" data-a="edit" data-id="${esc(x.c.id)}">${esc(x.c.title)}<small>${x.late ? 'Late · ' : ''}${x.c.time ? esc(x.c.time) + ' · ' : ''}${esc(fmtMins(x.c.minutes || 0))}${memberName(x.c.assignee) ? ' · ' + esc(memberName(x.c.assignee)) : ''}</small></button>`).join('')}
      <button class="day-add" data-a="new" data-date="${d}">+ Add</button></div>`;
  }).join('');
  return `<div class="page-head"><div><h1>${esc(label)}</h1><p>About ${esc(fmtMins(total))} of housework planned.</p></div>
    <div class="pills"><button class="btn" data-a="wk" data-id="-7" data-fk="wk-prev">Previous</button><button class="btn" data-a="wk" data-id="0" data-fk="wk-now">This week</button><button class="btn" data-a="wk" data-id="7" data-fk="wk-next">Next</button></div></div>
    <div class="filters">${peopleFilter()}</div><div class="week">${days}</div>`;
}
function weekEvents(d) {
  const bd = members().filter(m => isBirthday(m.id, d) && (me.admin || m.id === me.id)).map(m => `<div class="chip event">${esc(m.name)}'s birthday</div>`).join('');
  return bd + [...S.events.values(), ...linkedEvents()].filter(e => eventDateFrom(e, d) === d).map(e => `<button class="chip event" data-a="event-open" data-id="${esc(e.id)}">${esc(e.title)}${e.time ? `<small>${esc(e.time)}</small>` : ''}</button>`).join('');
}
function weekSchool(d) {
  const trip = tripOn(d);
  if (trip) return `<div class="chip holiday">Family holiday<small>${esc(trip.name)}</small></div>`;
  const people = members().filter(m => who === 'all' || m.id === who);
  const hols = holidays().filter(h => h.from <= d && h.to >= d && (!(h.people || []).length || people.some(m => h.people.includes(m.id))));
  const lessons = people.map(m => ({ m, t: schoolDay(d, m.id) })).filter(x => x.t);
  const aways = listedAway().filter(a => a.from <= d && a.to >= d && people.some(m => m.id === a.memberId));
  return aways.map(a => `<div class="chip away">${esc(memberName(a.memberId))}<small>${esc(awayReason(a))}</small></div>`).join('') + hols.map(h => `<div class="chip holiday">${esc(h.name)}${(h.people || []).length ? `<small>${esc(h.people.map(memberName).filter(Boolean).join(', '))}</small>` : ''}</div>`).join('')
    + lessons.map(x => `<div class="chip school">${esc(x.m.name)}<small>${esc(x.t.place)}, ${esc(x.t.start)} to ${esc(x.t.end)}</small></div>`).join('')
    + workShifts().filter(w => w.date === d && people.some(m => m.id === w.memberId)).reverse().map(w => `<div class="chip work">${esc(memberName(w.memberId))}<small>${esc(w.note || 'Work')}, ${esc(w.start)} to ${esc(workEnd(w))}</small></div>`).join('');
}
/* The newest of what the server said and what's in the log here. Admins have the whole log, so theirs is always up to date. */
function lastDoneOf(choreId) {
  let best = me.admin ? null : lastDoneInfo[choreId] || null;
  for (const l of S.log.values()) if (l.choreId === choreId && !l.rejected && l.date && (!best || (l.stamp || 0) >= (best.stamp || 0))) best = { date: l.date, by: l.by || '', stamp: l.stamp || 0 };
  return best;
}
function lastDoneText(last) {
  if (!last) return 'Not done yet';
  const today = localToday(), when = last.date === today ? 'today' : last.date === addDays(today, -1) ? 'yesterday' : `on ${fmtShort(last.date)}`;
  return `Last done ${when}${last.stamp ? ` at ${clockTime(last.stamp)}` : ''}${memberName(last.by) ? ` by ${memberName(last.by)}` : ''}`;
}
function viewRooms() {
  const today = localToday();
  const all = allChores().map(effective); const monthly = all.reduce((s, c) => s + perMonth(c), 0);
  const doneBy = c => c.everyone ? ((c.people || []).length ? c.people.map(memberName).filter(Boolean).join(', ') : 'Everyone') : memberName(c.assignee) || (c.anyLevel ? `Anyone in: ${levelNames(c.anyLevel) || 'nobody yet'}` : 'Anyone');
  const cards = rooms().map(r => {
    const list = all.filter(c => c.roomId === r.id).sort((a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : (a.time || '99').localeCompare(b.time || '99'));
    const next = list[0];
    const late = list.filter(c => c.due < today).length;
    const pct = list.length ? Math.round((list.length - late) / list.length * 100) : 100;
    const load = list.reduce((s, c) => s + perMonth(c), 0);
    return `<article class="room"><div class="room-top"><h2>${esc(r.name)}</h2><button class="link" data-a="room-edit" data-id="${esc(r.id)}" aria-label="Rename or delete ${esc(r.name)}">Edit</button></div>
      <div class="condition" role="img" aria-label="${pct}% on track"><span style="width:${pct}%"></span></div>
      <div class="room-sub">${late ? `${late} late` : 'All on track'} · about ${esc(fmtMins(load))} a month</div>
      ${(() => { const last = list.map(c => lastDoneOf(c.id)).filter(Boolean).sort((a, b) => b.stamp - a.stamp)[0]; return list.length ? `<p class="room-next room-last">${esc(lastDoneText(last).replace('Last done', 'Last clean').replace('Not done yet', 'Not cleaned yet'))}</p>` : ''; })()}
      ${next ? `<p class="room-next">Next clean: <b>${esc(next.due === today ? 'Today' : fmtShort(next.due))}${next.time ? ` ${esc(next.time)}` : ''}</b> by <b>${esc(doneBy(next))}</b></p>` : ''}
      ${list.length ? `<ul class="room-chores">${list.map(c => `<li><button class="room-chore" data-a="edit" data-id="${esc(c.id)}"><span class="room-chore-title">${esc(c.title)}</span><span class="row-meta"><span class="${c.due < today ? 'when-late' : ''}">${esc(c.due === today ? 'Today' : fmtShort(c.due))}${c.time ? ` ${esc(c.time)}` : ''}</span> · ${esc(doneBy(c))}${c.coverFor ? ` instead of ${esc(memberName(c.coverFor))}` : ''}</span><span class="row-meta room-last-done">${esc(lastDoneText(lastDoneOf(c.id)))}</span></button>${me.admin ? `<button class="btn small" data-a="swap-open" data-id="${esc(c.id)}" aria-label="Swap ${esc(c.title)} to someone else">Swap</button>${c.unit !== 'once' ? `<button class="btn small" data-a="skip" data-id="${esc(c.id)}" aria-label="Skip ${esc(c.title)} until next time">Skip</button>` : ''}` : ''}</li>`).join('')}</ul>` : ''}
      <button class="btn small" data-a="new" data-room="${esc(r.id)}">Add to ${esc(r.name)}</button></article>`;
  }).join('');
  return `<div class="page-head"><div><h1>Rooms</h1><p>${all.length} chores, about ${esc(fmtMins(monthly))} a month in total.</p></div>
    <div class="pills"><button class="btn" data-a="room-new">Add room</button><button class="btn" data-a="templates">Add from templates</button></div></div>
    <div class="room-grid">${cards}</div>`;
}
function viewProgress() {
  const today = localToday(), week = mondayOf(today), all = logs();
  const s = streaks(all.map(l => l.date), today);
  const tally = new Map(members().filter(m => me.admin || m.id === me.id).map(m => [m.id, 0]));
  let thisWeek = 0;
  for (const l of all) if (l.date >= week) { thisWeek += l.minutes || 0; tally.set(l.by && S.members.has(l.by) ? l.by : '', (tally.get(l.by && S.members.has(l.by) ? l.by : '') || 0) + (l.minutes || 0)); }
  const bars = [...tally.entries()].filter(([id, v]) => id || v).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...bars.map(b => b[1]));
  const roomsDone = new Set(all.filter(l => l.date >= week).map(l => l.roomId));
  const everyRoom = rooms().length > 0 && rooms().every(r => roomsDone.has(r.id));
  const badges = [['First tick', 'Finish a chore', all.length >= 1], ['Week strong', '7 days in a row', s.best >= 7], ['Habit formed', '30 days in a row', s.best >= 30], ['Fifty down', 'Finish 50 chores', all.length >= 50], ['Spring clean', 'Every room this week', everyRoom], ['House proud', 'Finish 250 chores', all.length >= 250]];
  return `<div class="page-head"><div><h1>Progress</h1><p>Who's done what since Monday, and how long you've kept it up.</p></div></div>
  <div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:28px">
    <div class="stat"><b>${s.current}</b><span>day streak</span></div><div class="stat"><b>${s.best}</b><span>best streak</span></div><div class="stat"><b>${esc(fmtMins(thisWeek).replace(' min', 'm'))}</b><span>this week</span></div></div>
  <div class="cols"><div>
    <h2 class="sec">${me.admin ? 'Share of the work' : 'Your work'}</h2>
    ${bars.length ? bars.map(([id, v]) => `<div class="bar-row"><span>${esc(id ? memberName(id) : 'Not credited')}</span><div class="bar"><span style="width:${v / max * 100}%"></span></div><span>${esc(fmtMins(v))}</span></div>`).join('') : '<p class="empty">Add people below to see who did what.</p>'}
    <h2 class="sec" style="margin-top:28px">Badges</h2>
    <ul class="badges">${badges.map(([t, d, w]) => `<li class="badge ${w ? 'won' : ''}"><b>${t}</b>${d}</li>`).join('')}</ul>
  </div><div>
    <h2 class="sec">Household</h2>
    ${householdHTML()}
    ${me.admin ? groupsQuickHTML() : ''}
    <h2 class="sec" style="margin-top:28px">Recently done</h2>
    ${all.length ? `<ul class="mini">${all.slice(0, 12).map(l => `<li><span>${esc(l.title)}${memberName(l.by) ? ' · ' + esc(memberName(l.by)) : ''}</span><span>${esc(fmt(l.date, { day: 'numeric', month: 'short' }))}</span></li>`).join('')}</ul>` : '<p class="empty">Nothing ticked off yet.</p>'}
    ${accountHTML()}
  </div></div>`;
}
/* Quick group setup: everyone with a cleaner sign-in against the groups, one tick box each. Saves as soon as a box changes. */
let groupsShowAll = false;
function groupsQuickHTML() {
  const people = members().filter(m => logins[m.id] && logins[m.id].cleaner);
  if (!people.length) return `<h2 class="sec" style="margin-top:28px">Groups</h2><p class="empty">Give someone a cleaner sign-in to put them in a group.</p>`;
  const used = Math.max(0, ...people.flatMap(m => logins[m.id].groups || []));
  const cols = groupsShowAll ? GROUPS : GROUPS.slice(0, Math.min(GROUPS.length, Math.max(3, used + 1)));
  const list = GROUPS.filter(n => people.some(m => (logins[m.id].groups || []).includes(n)));
  return `<h2 class="sec" style="margin-top:28px">Groups</h2>
    <ul class="mini group-list">${list.length ? list.map(n => `<li><span><b>Group ${n}</b></span><span>${esc(people.filter(m => (logins[m.id].groups || []).includes(n)).map(m => m.name).join(', '))}</span></li>`).join('') : '<li><span>Nobody is in a group yet.</span></li>'}</ul>
    <p class="hint">Quick setup: tick the groups each person is in. It saves straight away.</p>
    <div class="group-grid-wrap"><table class="group-grid"><thead><tr><th scope="col">Person</th>${cols.map(n => `<th scope="col">${n}</th>`).join('')}</tr></thead><tbody>
    ${people.map(m => { const g = logins[m.id].groups || []; return `<tr><th scope="row">${esc(m.name)}</th>${cols.map(n => `<td><input type="checkbox" data-quickgroup="${n}" data-id="${esc(m.id)}" ${g.includes(n) ? 'checked' : ''} aria-label="${esc(m.name)} in group ${n}"></td>`).join('')}</tr>`; }).join('')}
    </tbody></table></div>
    ${cols.length < GROUPS.length ? '<button class="link" data-a="groups-all">Show all 10 groups</button>' : ''}`;
}
const groupLabel = g => !g.length ? 'no group' : g.length === 1 ? `group ${g[0]}` : `groups ${g.slice(0, -1).join(', ')} and ${g[g.length - 1]}`;
const roleNames = l => [l.cleaner && `Cleaner, ${groupLabel(l.groups || [])}`, l.admin && 'Admin', l.system && 'System user'].filter(Boolean).join(' · ');
/* Phone notifications */
let pushInfo = null, pushSub = null, pushBusy = false;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
async function loadPush() {
  if (!pushSupported() || !me) { scheduleRender(); return; }
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    pushSub = await reg.pushManager.getSubscription();
    pushInfo = await call('GET', 'push/key');
    /* Keep the server's list right, for example after the same phone signs in as someone else. */
    if (pushSub && Notification.permission === 'granted') await call('POST', 'push/subscribe', { subscription: pushSub.toJSON() });
  } catch (e) { /* the section offers to try again */ }
  scheduleRender();
}
async function pushOn() {
  if (pushBusy) return; pushBusy = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your phone settings, then try again.');
    const reg = await navigator.serviceWorker.register('sw.js'), ready = await navigator.serviceWorker.ready;
    if (!pushInfo) pushInfo = await call('GET', 'push/key');
    const raw = atob(pushInfo.key.replace(/-/g, '+').replace(/_/g, '/')), key = Uint8Array.from(raw, ch => ch.charCodeAt(0));
    pushSub = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await call('POST', 'push/subscribe', { subscription: pushSub.toJSON() });
    await pushTest();
  } catch (e) { toast(e.message || "Notifications couldn't be turned on."); }
  pushBusy = false; scheduleRender();
}
let pushResult = null;
/* Tests each step on its own, and says which one fails. */
async function pushTest() {
  const out = { perm: Notification.permission, local: '', server: [] };
  try { const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('the notification helper did not start')), 8000))]); await reg.showNotification('Family Planner', { body: 'Test 1: this came from this device.', tag: 'test-local' }); out.local = 'ok'; }
  catch (e) { out.local = `${e.name}: ${e.message}`; }
  try { const r = await call('POST', 'push/test'); out.server = r.results || []; }
  catch (e) { out.server = [{ ok: false, host: 'the app', status: e.status || 0, why: e.message }]; }
  pushResult = out; scheduleRender();
}
function pushResultHTML() {
  if (!pushResult) return '';
  const r = pushResult, good = r.local === 'ok' && r.server.length && r.server.every(x => x.ok);
  const lines = [`<li>Notifications allowed on this phone: <b>${r.perm === 'granted' ? 'Yes' : `No (${esc(r.perm)})`}</b></li>`, `<li>Test 1, shown by this phone: <b>${r.local === 'ok' ? 'Sent' : `Failed (${esc(r.local)})`}</b></li>`,
    ...r.server.map(x => `<li>Test 2, sent by the server through ${esc(x.host)}: <b>${x.ok ? `Accepted (${x.status})` : `Refused (${x.status || 'no connection'})${x.why ? `: ${esc(x.why)}` : ''}`}</b></li>`)];
  if (!r.server.length) lines.push('<li>Test 2: <b>this phone is not registered on the server</b>. Turn off, then on again.</li>');
  return `<div class="notice push-result"><div><b>Test results</b><ul>${lines.join('')}</ul><p class="hint">${good ? 'You should now have 2 notifications. If neither appears, check notification settings for this app, Focus or Do Not Disturb. If only Test 1 appears, send me these results.' : 'Send me these results.'}</p></div></div>`;
}
async function pushOff() {
  try {
    if (pushSub) { await call('POST', 'push/unsubscribe', { endpoint: pushSub.endpoint }); await pushSub.unsubscribe(); pushSub = null; }
    toast('Notifications are off on this device.');
  } catch (e) { toast(e.message); }
  scheduleRender();
}
function pushHTML() {
  let body;
  if (!pushSupported()) body = isIphone() ? '<p class="hint">On iPhone, tap Share, then Add to Home Screen, then open Family Planner from that icon and come back here. It needs iOS 16.4 or newer.</p>' : `<p class="hint">This browser can't receive notifications.</p>`;
  else if (pushSub) {
    const p = (pushInfo && pushInfo.prefs) || { chat: true, chores: true, clock: true };
    body = `<p class="hint">On for this device. Nothing is sent during your school or college times, work shifts or nights away.</p>
      <label class="inline-check"><input type="checkbox" id="push-chat" ${p.chat ? 'checked' : ''}> Chat messages</label>
      <label class="inline-check"><input type="checkbox" id="push-chores" ${p.chores ? 'checked' : ''}> Chores not done, and chores sent back</label>
      ${logins[me.id] && logins[me.id].admin ? `<label class="inline-check"><input type="checkbox" id="push-clock" ${p.clock ? 'checked' : ''}> When a chore is done</label>` : ''}
      <div class="pills" style="margin-top:10px"><button class="btn" data-a="push-test">Send a test</button><button class="btn" data-a="push-off">Turn off</button></div>${pushResultHTML()}`;
  } else body = `<p class="hint">Get chat messages and chore reminders on this device, even when the app is closed.</p><div class="pills"><button class="btn primary" data-a="push-on">Turn on notifications</button></div>`;
  return `<h2 class="sec" style="margin-top:28px">Notifications</h2>${body}`;
}
function accountHTML() {
  return `<div class="install-slot">${installHTML()}</div>${pushHTML()}<h2 class="sec" style="margin-top:28px">Your account</h2>
    <p class="hint">Signed in as ${esc(me.username)}${roleNames(logins[me.id] || me) ? ` (${esc(roleNames(logins[me.id] || me))})` : ''}${me.canSwitch ? `, in ${me.mode === 'admin' ? 'Admin' : 'Cleaner'} mode` : ''}.</p>
    <div class="pills"><button class="btn" data-a="pw-open">Change password</button><button class="btn" data-a="sign-out">Sign out</button></div>`;
}
const NIGHT_ICONS = ['🎬', '🎲', '🍹', '🍖', '👪', '👫', '🎉', '🍿', '🎤', '🎵', '🎂', '🍕', '⚽', '🎳', '🎭', '🏕️', '🏖️', '🎆', '🎁', '☕'];
const upcomingNights = () => [...S.nights.values()].filter(n => n.date >= localToday()).sort((a, b) => (a.date + a.time) < (b.date + b.time) ? -1 : 1);
const canAddNight = () => !!me && (me.admin || (me.cleaner && nightGroups.some(n => (levels[n] || []).includes(me.id))));
const canEditNight = n => !!me && (me.admin || (canAddNight() && n.createdBy === me.id));
/* Not stored as reminders, so they can't drift from the night or dinner they came from. */
function linkedEvents() {
  const one = (id, title, date, time) => ({ id, title, date, time, unit: 'once', every: 1, notes: '', people: [] });
  return [...[...S.nights.values()].map(n => one(`night:${n.id}`, `${n.icon} ${n.name}`, n.date, n.time)),
    ...[...S.dinners.values()].filter(d => d.kind === 'takeaway' || d.kind === 'out').map(d => one(`dinner:${d.id}`, dinnerText(d).title, d.id, '')),
    ...[...S.outings.values()].map(o => ({ ...one(`out:${o.id}`, `${memberName(o.memberId) || 'Someone'}: ${o.activity}`, o.from, o.start), unit: o.weekly ? 'week' : 'once' })),
    ...listedAway().map(a => one(`away:${a.id}`, `${memberName(a.memberId) || 'Someone'}: ${awayReason(a)}`, a.from, a.allDay === false ? a.leave : '')),
    ...[...S.dinnerTasks.values()].filter(t => me.admin || (levels[t.group] || []).includes(me.id)).map(t => one(`dinner:${t.id}`, me.admin && levelNames(t.group) ? `${t.text} (${levelNames(t.group)})` : t.text, t.date, ''))];
}
const nightRow = n => `<li class="shift night-row"><span class="night-icon" aria-hidden="true">${esc(n.icon)}</span><div class="dinner-text"><b>${esc(n.name)}</b><span class="row-meta">${esc(fmtShort(n.date))}, ${esc(n.time)}${n.by ? ` · Added by ${esc(n.by)}` : ''}</span></div>${canEditNight(n) ? `<button class="btn small" data-a="night-open" data-id="${esc(n.id)}" aria-label="Edit ${esc(n.name)} on ${esc(fmtShort(n.date))}">Edit</button>` : ''}</li>`;
function viewFun() {
  const list = upcomingNights();
  const types = [...S.nightTypes.values()].sort((a, b) => a.name.localeCompare(b.name));
  const admin = !me.admin ? '' : `<h2 class="sec" style="margin-top:32px">Options</h2><ul class="rows shifts">${types.map(t => `<li class="shift night-row"><span class="night-icon" aria-hidden="true">${esc(t.icon)}</span><div class="dinner-text"><b>${esc(t.name)}</b></div><button class="btn small" data-a="nt-del" data-id="${esc(t.id)}" aria-label="Remove ${esc(t.name)}">Remove</button></li>`).join('')}</ul>
    <form id="nt-form" class="member" style="margin-top:12px"><select id="nt-icon" aria-label="Icon">${NIGHT_ICONS.map(i => `<option value="${i}">${i}</option>`).join('')}</select><input type="text" id="nt-name" maxlength="40" placeholder="Add an option" aria-label="Add an option" autocomplete="off"><button class="btn primary">Add</button></form>
    <h2 class="sec" style="margin-top:32px">Who can add nights</h2><p class="hint">Admins always can. Tick the groups that can too.</p>
    <div class="checks night-groups">${GROUPS.filter(n => (levels[n] || []).length || nightGroups.includes(n)).map(n => `<label class="inline-check"><input type="checkbox" data-nightgroup="${n}" ${nightGroups.includes(n) ? 'checked' : ''}> Group ${n}: ${esc(levelNames(n) || 'nobody yet')}</label>`).join('') || '<p class="empty">No groups have people in them yet.</p>'}</div>`;
  return `${scheduleNav('fun')}<div class="page-head"><div><h1>Entertainment</h1><p>Nights coming up.</p></div>${canAddNight() ? '<button class="btn primary" data-a="night-new">Add a night</button>' : ''}</div>
    ${list.length ? `<ul class="rows shifts">${list.map(nightRow).join('')}</ul>` : '<p class="empty">Nothing planned yet.</p>'}${admin}`;
}
function openNight(n) {
  const today = localToday(), types = [...S.nightTypes.values()].sort((a, b) => a.name.localeCompare(b.name));
  const opts = [...types, ...(n.id && !S.nightTypes.has(n.typeId) ? [{ id: n.typeId, name: n.name, icon: n.icon }] : [])];
  openSheet(`<form id="night-form" data-id="${esc(n.id || '')}"><h2 id="sheet-title">${n.id ? 'Edit night' : 'Add a night'}</h2>
    <fieldset><legend>What kind of night?</legend><div class="night-opts">${opts.map(t => `<label class="night-opt"><input type="radio" name="nf-type" value="${esc(t.id)}" required ${n.typeId === t.id ? 'checked' : ''}><span aria-hidden="true">${esc(t.icon)}</span> ${esc(t.name)}</label>`).join('')}</div></fieldset>
    <div class="two"><div class="field"><label class="lab" for="nf-date">Date</label><input type="date" id="nf-date" required min="${esc(today)}" value="${esc(n.date || today)}"></div><div class="field"><label class="lab" for="nf-time">Time</label><input type="time" id="nf-time" required value="${esc(n.time || '')}"></div></div>
    <p class="form-error" id="nf-error" role="alert" hidden></p>
    <div class="actions">${n.id ? `<span class="left"><button type="button" class="btn danger" data-a="night-del" data-id="${esc(n.id)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
/* The page anyone can see before signing in. */
let whatsOnData = null;
function whatsOnHTML() {
  if (!whatsOnData) return '';
  const dinners = whatsOnData.dinners.map(d => { const t = dinnerText(d); return `<li class="shift"><div class="dinner-text"><span class="row-meta">${esc(fmtShort(d.date))}</span><b>${esc(t.title)}</b>${d.group ? `<span class="row-meta">Group ${d.group} cooking</span>` : ''}</div></li>`; }).join('');
  const nights = whatsOnData.nights.map(n => `<li class="shift night-row"><span class="night-icon" aria-hidden="true">${esc(n.icon)}</span><div class="dinner-text"><b>${esc(n.name)}</b><span class="row-meta">${esc(fmtShort(n.date))}, ${esc(n.time)}</span></div></li>`).join('');
  return `<h2 class="sec">Dinner</h2>${dinners ? `<ul class="rows shifts">${dinners}</ul>` : '<p class="empty">No dinners planned yet.</p>'}<h2 class="sec" style="margin-top:24px">Entertainment</h2>${nights ? `<ul class="rows shifts">${nights}</ul>` : '<p class="empty">Nothing planned yet.</p>'}`;
}
async function loadWhatsOn() {
  try { const r = await fetch('api/whats-on'); if (r.ok) whatsOnData = await r.json(); } catch (e) { return; }
  const box = document.getElementById('whats-on'); if (box) box.innerHTML = whatsOnHTML();
}
setInterval(() => { if (signedOut && !document.hidden) loadWhatsOn(); }, 60000);
function viewSchool() {
  const today = localToday();
  const people = members().filter(m => me.admin || S.schedules.has(m.id));
  const cards = people.map(m => {
    const sc = S.schedules.get(m.id), hol = sc ? holidayFor(today, m.id) : null;
    const days = sc ? DAY_NAMES.map((n, i) => { const t = sc.days[i + 1]; return t ? `<li class="${dayNumber(today) === i + 1 ? 'is-today' : ''}"><span>${n}</span><span>${esc(t.start)} to ${esc(t.end)}</span></li>` : ''; }).join('') : '';
    return `<article class="room"><div class="room-top"><h2>${esc(m.name)}</h2>${me.admin ? `<button class="link" data-a="sched-open" data-id="${esc(m.id)}" aria-label="Set times for ${esc(m.name)}">${sc ? 'Change' : 'Set times'}</button>` : ''}</div>
      ${sc ? `<div class="room-sub">${esc(sc.place)}${hol ? ` · <b>On holiday: ${esc(hol.name)}</b>` : ''}</div>${days ? `<ul class="mini sched-list">${days}</ul>` : '<p class="hint">No days set.</p>'}` : '<p class="hint">No school or college times.</p>'}</article>`;
  }).join('');
  const nightList = upcomingNights();
  const outRows = [...S.outings.values()].filter(o => o.weekly || o.to >= today).sort((a, b) => memberName(a.memberId).localeCompare(memberName(b.memberId)) || a.from.localeCompare(b.from)).map(o => `<li class="shift"><div><b>${esc(memberName(o.memberId))}</b> · ${esc(o.activity)}<span class="row-meta">${o.weekly ? `Every ${esc(fmt(o.from, { weekday: 'long' }))}` : `${esc(fmtShort(o.from))}${o.from === o.to ? '' : ` to ${esc(fmtShort(o.to))}`}`} · ${o.start ? `${esc(o.start)} to ${esc(o.end)}` : 'All day'}</span></div><button class="btn small" data-a="out-open" data-id="${esc(o.id)}" aria-label="Change ${esc(o.activity)}">Edit</button></li>`).join('');
  const sickRows = members().filter(m => sickUntil(m.id)).map(m => `<li class="shift"><div><b>${esc(m.name)}</b> · Off sick<span class="row-meta">Chores paused until ${esc(stampText(sickUntil(m.id)))}</span></div><div class="pills"><button class="btn small" data-a="sick-again" data-id="${esc(m.id)}">Another 12 hours</button><button class="btn small" data-a="sick-end" data-id="${esc(m.id)}">End now</button></div></li>`).join('');
  const tripRows = [...S.trips.values()].filter(t => t.to >= today).sort((a, b) => a.from < b.from ? -1 : 1).map(t => `<li class="shift"><div><b>${esc(t.name)}</b><span class="row-meta">${esc(fmtShort(t.from))}${t.from === t.to ? '' : ` to ${esc(fmtShort(t.to))}`}</span></div>${me.admin ? `<button class="btn small" data-a="trip-open" data-id="${esc(t.id)}">Edit</button>` : ''}</li>`).join('');
  const hols = holidays().filter(h => h.to >= addDays(today, -30));
  const holRows = hols.map(h => `<li class="shift"><div><b>${esc(h.name)}</b><span class="row-meta">${esc(fmtShort(h.from))}${h.from === h.to ? '' : ` to ${esc(fmtShort(h.to))}`} · ${(h.people || []).length ? esc(h.people.map(memberName).filter(Boolean).join(', ')) : 'Everyone'}</span></div>${me.admin ? `<button class="btn small" data-a="hol-open" data-id="${esc(h.id)}">Edit</button>` : ''}</li>`).join('');
  const week = mondayOf(today), weekEnd = addDays(week, 6);
  const shown = workShifts().filter(w => w.date >= addDays(today, -14)).reverse();
  const hours = new Map();
  for (const w of workShifts()) if (w.date >= week && w.date <= weekEnd) hours.set(w.memberId, (hours.get(w.memberId) || 0) + workMins(w));
  const workRows = shown.map(w => `<li class="shift"><div><b>${esc(memberName(w.memberId))}</b>${w.note ? ` · ${esc(w.note)}` : ''}<span class="row-meta">${esc(fmtShort(w.date))}, ${esc(w.start)} to ${esc(workEnd(w))} · ${esc(fmtMins(workMins(w)))}</span></div>${me.admin ? `<button class="btn small" data-a="work-open" data-id="${esc(w.id)}">Edit</button>` : ''}</li>`).join('');
  const awayRows = listedAway().filter(a => a.to >= today).sort((a, b) => a.from < b.from ? -1 : 1).map(a => `<li class="shift"><div><b>${esc(memberName(a.memberId))}</b> · ${esc(awayReason(a))}<span class="row-meta">${esc(fmtShort(a.from))}${a.from === a.to ? '' : ` to ${esc(fmtShort(a.to))}`} · ${sameDayAway(a) ? `leaves ${esc(a.leave)}, back ${esc(a.back)}` : a.allDay === false ? `leaves ${esc(a.leave)}, back ${esc(a.back)} on ${esc(fmtShort(addDays(a.to, 1)))}` : 'All day'} · Chores go to each chore's second person, or move to the next day</span></div>${me.admin ? `<button class="btn small" data-a="away-open" data-id="${esc(a.id)}">Edit</button>` : ''}</li>`).join('');
  return `${scheduleNav('school')}<div class="page-head"><div><h1>Schedule</h1><p>Work shifts, school times, holidays and entertainment.</p></div></div>
    ${nightList.length ? `<h2 class="sec">Entertainment</h2><ul class="rows shifts" style="margin-bottom:32px">${nightList.map(nightRow).join('')}</ul>` : ''}
    <div class="page-head"><div><h2 class="sec" style="margin:0">${me.admin ? 'Work shifts' : 'Your work shifts'}</h2></div>${me.admin ? '<button class="btn primary" data-a="work-open">Log a shift</button>' : ''}</div>
    ${calendarHTML()}
    ${[...hours.entries()].map(([id, v]) => `<p class="hint">${esc(memberName(id))}: ${esc(fmtMins(v))} this week</p>`).join('')}
    ${workRows ? `<ul class="rows shifts" style="margin-bottom:32px">${workRows}</ul>` : `<p class="empty">${me.admin ? 'No work shifts logged.' : 'You have no work shifts logged.'}</p>`}
    ${me.admin ? `<div class="page-head"><div><h2 class="sec" style="margin:0">Off sick</h2></div><button class="btn primary" data-a="sick-new">Log someone sick</button></div>${sickRows ? `<ul class="rows shifts" style="margin-bottom:32px">${sickRows}</ul>` : '<p class="empty">Nobody is off sick.</p>'}` : ''}
    <div class="page-head"><div><h2 class="sec" style="margin:0">${me.admin ? 'Activities' : 'Your activities'}</h2><p class="hint">These show in Who is out today.</p></div><button class="btn primary" data-a="out-open">Add an activity</button></div>
    ${awayRows || outRows ? `<ul class="rows shifts" style="margin-bottom:32px">${awayRows}${outRows}</ul>` : '<p class="empty">No activities yet.</p>'}
    ${me.admin ? `<h2 class="sec">Suggested activities</h2><div class="reason-list">${[...S.awayReasons.values()].map(r => `<div class="member"><input type="text" id="ar-${esc(r.id)}" maxlength="40" value="${esc(r.name)}" aria-label="Reason"><button class="btn" data-a="ar-save" data-id="${esc(r.id)}" aria-label="Save ${esc(r.name)}">Save</button><button class="btn" data-a="ar-del" data-id="${esc(r.id)}" aria-label="Remove ${esc(r.name)}">Remove</button></div>`).join('')}</div>
    <form id="ar-form" class="member" style="margin:8px 0 32px"><input type="text" id="ar-new" maxlength="40" placeholder="Add a suggestion" aria-label="Add a suggestion" autocomplete="off"><button class="btn primary">Add</button></form>` : ''}
    <h2 class="sec">${me.admin ? 'School and college' : 'Your school or college'}</h2><p class="hint" style="margin-bottom:12px">Times don't show during a school or family holiday.</p>
    ${cards ? `<div class="room-grid">${cards}</div>` : `<p class="empty">${me.admin ? 'No school or college times have been set.' : 'You have no school or college times.'}</p>`}
    <div class="page-head" style="margin-top:12px"><div><h2 class="sec" style="margin:0">Family holidays</h2><p class="hint" style="margin:2px 0 0">Everyone is away and nobody is home: no schedule or alerts, and chores wait until you're back.</p></div>${me.admin ? '<button class="btn primary" data-a="trip-open">Add family holiday</button>' : ''}</div>
    ${tripRows ? `<ul class="rows shifts" style="margin-bottom:32px">${tripRows}</ul>` : '<p class="empty">No family holidays added.</p>'}
    <div class="page-head" style="margin-top:12px"><div><h2 class="sec" style="margin:0">${me.admin ? 'School holidays' : 'Your school holidays'}</h2><p class="hint" style="margin:2px 0 0">You're home: school times are hidden and reminders carry on.</p></div>${me.admin ? '<button class="btn primary" data-a="hol-open">Add school holiday</button>' : ''}</div>
    ${holRows ? `<ul class="rows shifts">${holRows}</ul>` : '<p class="empty">No school holidays added.</p>'}`;
}
/* Logs: admins only */
let calMonth = null;
function calendarHTML() {
  const today = localToday();
  const first = (calMonth || today.slice(0, 7)) + '-01', start = mondayOf(first);
  const month = first.slice(0, 7);
  const end = addDays(first, 31).slice(0, 7);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d.slice(0, 7) !== month) break;
    const shifts = workShifts().filter(w => w.date === d);
    const mins = shifts.reduce((t, w) => t + workMins(w), 0);
    const away = listedAway().some(a => a.from <= d && a.to >= d);
    cells.push(`<button class="cal-day ${d.slice(0, 7) === month ? '' : 'other'} ${d === today ? 'today' : ''} ${shifts.length ? 'has' : ''}" data-a="cal-day" data-id="${d}" aria-label="${esc(fmtShort(d))}${shifts.length ? `, ${shifts.length} work ${shifts.length === 1 ? 'shift' : 'shifts'}` : ''}${away ? ', someone away' : ''}"><b>${toD(d).getUTCDate()}</b>${mins ? `<small>${esc(fmtMins(mins).replace(' min', 'm'))}</small>` : ''}${away ? '<i>Away</i>' : ''}</button>`);
  }
  return `<div class="cal"><div class="cal-head"><button class="btn small" data-a="cal-move" data-id="-1" aria-label="Previous month">Previous</button><b>${esc(fmt(first, { month: 'long', year: 'numeric' }))}</b><button class="btn small" data-a="cal-move" data-id="1" aria-label="Next month">Next</button></div>
    <div class="cal-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => `<span class="cal-name">${n}</span>`).join('')}${cells.join('')}</div>${me.admin ? '<p class="hint">Tap a day to add or change hours.</p>' : ''}</div>`;
}
function openDay(d) {
  const shifts = workShifts().filter(w => w.date === d).reverse();
  const away = listedAway().filter(a => a.from <= d && a.to >= d);
  openSheet(`<div><h2 id="sheet-title">${esc(fmt(d, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
    ${shifts.length ? `<ul class="rows shifts">${shifts.map(w => `<li class="shift"><div><b>${esc(memberName(w.memberId))}</b>${w.note ? ` · ${esc(w.note)}` : ''}<span class="row-meta">${esc(w.start)} to ${esc(workEnd(w))} · ${esc(fmtMins(workMins(w)))}</span></div>${me.admin ? `<button class="btn small" data-a="work-open" data-id="${esc(w.id)}">Edit</button>` : ''}</li>`).join('')}</ul>` : '<p class="hint">No work hours on this day.</p>'}
    ${away.map(a => `<p class="hint">${esc(memberName(a.memberId))}: ${esc(awayReason(a))}.</p>`).join('')}
    <div class="actions">${me.admin ? `<span class="left"><button type="button" class="btn" data-a="away-open" data-date="${d}">Add an activity</button></span>` : ''}<button type="button" class="btn" data-a="close">Close</button>${me.admin ? `<button type="button" class="btn primary" data-a="work-open" data-date="${d}">Add hours</button>` : ''}</div></div>`);
}
let logsData = null, logsLoading = false, logsTab = 'signins', logsWho = 'all';
async function loadLogs() {
  if (logsLoading) return; logsLoading = true;
  try { logsData = await call('GET', 'logs'); } catch (e) { logsData = { error: e.message }; }
  logsLoading = false; scheduleRender();
}
const stampText = ms => `${fmtShort(shiftDate(ms))}, ${clockTime(ms)}`;
const ACTIVITY = { signin: 'Signed in', signout: 'Signed out', open: 'Opened the app', 'auto-out': 'Clocked out automatically', snooze: 'Snoozed reminders for 1 hour', skip: 'Skipped a chore until next time', 'shift-edit': 'Cleaning session times changed' };
let report = null, reportLoading = false, stats = null, statsLoading = false, statsMetric = 'cleaning';
async function loadStats() {
  if (statsLoading) return; statsLoading = true;
  try { stats = await call('GET', 'logs/stats'); } catch (e) { stats = { error: e.message }; }
  statsLoading = false; scheduleRender();
}
const fmtHours = m => { if (!m) return '0h'; const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };
const METRICS = { cleaning: { label: 'Estimated cleaning', fmt: fmtHours, hours: true }, chores: { label: 'Chores done', fmt: n => String(n) }, work: { label: 'Work/School hours', fmt: fmtHours, hours: true } };
function statsPeople() { return Object.keys(stats.people).filter(id => S.members.has(id) && (logsWho === 'all' || id === logsWho)).sort((a, b) => memberName(a).localeCompare(memberName(b))); }
function sumDays(id, kind, from) { return stats.dates.reduce((t, d, i) => t + (!from || d >= from ? stats.people[id][kind][i] : 0), 0); }
function hoursHTML() {
  if (!stats) { loadStats(); return '<div class="empty">Working out the hours…</div>'; }
  if (stats.error) return `<div class="empty">${esc(stats.error)}</div>`;
  const today = localToday(), week = mondayOf(today), last = addDays(week, -7);
  const between = (id, kind, a, b) => stats.dates.reduce((t, d, i) => t + (d >= a && d < b ? stats.people[id][kind][i] : 0), 0);
  const ids = statsPeople();
  const cells = (id, kind) => `<td>${esc(fmtHours(sumDays(id, kind, week)))}</td><td>${esc(fmtHours(between(id, kind, last, week)))}</td><td>${esc(fmtHours(sumDays(id, kind)))}</td>`;
  const table = (title, kind, note) => `<h2 class="sec" style="margin-top:18px">${title}</h2><p class="hint">${note}</p><div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Person</th><th scope="col">This week</th><th scope="col">Last week</th><th scope="col">Last 14 days</th></tr></thead><tbody>${ids.map(id => `<tr><th scope="row">${esc(memberName(id))}</th>${cells(id, kind)}</tr>`).join('')}</tbody></table></div>`;
  let days = '';
  if (logsWho !== 'all') {
    const rows = stats.dates.map((d, i) => ({ d, c: stats.people[logsWho]?.cleaning[i] || 0, w: stats.people[logsWho]?.work[i] || 0 })).filter(r => r.c || r.w).reverse();
    days = `<h2 class="sec" style="margin-top:18px">Day by day</h2>${rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Day</th><th scope="col">Cleaning</th><th scope="col">Work/School</th></tr></thead><tbody>${rows.map(r => `<tr><th scope="row">${esc(fmtShort(r.d))}</th><td>${esc(fmtHours(r.c))}</td><td>${esc(fmtHours(r.w))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No hours in the last 14 days.</p>'}`;
  }
  return table('Cleaning', 'cleaning', 'Estimated from the minutes set on each chore done.') + table('Work/School', 'work', 'Work shifts plus school or college times. Holidays and all-day nights away are left out. Past days use the current school times.') + days;
}
const STATS_SHOWN = 14;
function statsHTML() {
  if (!stats) { loadStats(); return '<div class="empty">Working out the stats…</div>'; }
  if (stats.error) return `<div class="empty">${esc(stats.error)}</div>`;
  const ids = statsPeople(), M = METRICS[statsMetric], kind = statsMetric;
  const dates = stats.dates.slice(-STATS_SHOWN), skip = stats.dates.length - dates.length;
  const daily = dates.map((d, i) => ids.reduce((t, id) => t + stats.people[id][kind][i + skip], 0));
  const total = daily.reduce((a, b) => a + b, 0);
  const sum = key => ids.reduce((t, id) => t + stats.people[id].recent[key], 0);
  const tiles = [['Estimated cleaning', fmtHours(ids.reduce((t, id) => t + sumDays(id, 'cleaning', dates[0]), 0))], ['Chores done', ids.reduce((t, id) => t + sumDays(id, 'chores', dates[0]), 0)], ['Work/School hours', fmtHours(ids.reduce((t, id) => t + sumDays(id, 'work', dates[0]), 0))], ['Delays', sum('delays')], ['Snoozes', sum('snoozes')], ['Sent back', sum('sentBack')]];
  const rawMax = Math.max(...daily, 0);
  const step = M.hours ? [15, 30, 60, 120, 240, 480, 960, 1920].find(x => x * 4 >= rawMax) || 3840 : [1, 2, 5, 10, 20, 50, 100].find(x => x * 4 >= rawMax) || 200;
  const top = Math.max(step, Math.ceil(rawMax / step) * step);
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const who = logsWho === 'all' ? 'Everyone' : memberName(logsWho);
  const bars = dates.map((d, i) => {
    const v = daily[i], label = `${fmtShort(d)}: ${M.fmt(v)}`;
    return `<button type="button" class="bar-col ${d === localToday() ? 'is-today' : ''}" data-tip="${esc(label)}" aria-label="${esc(label)}"><span class="bar-fill" style="height:${v ? Math.max(2, v / top * 100) : 0}%"></span></button>`;
  }).join('');
  const labels = dates.map((d, i) => (i % 3 === (dates.length - 1) % 3) ? `<span style="left:${(i + 0.5) / dates.length * 100}%">${esc(fmt(d, { day: 'numeric', month: 'short' }))}</span>` : '').join('');
  const ranked = ids.map(id => ({ id, v: sumDays(id, kind, dates[0]) })).sort((a, b) => b.v - a.v), rankTop = Math.max(1, ranked[0] ? ranked[0].v : 1);
  const compare = logsWho === 'all' && ranked.length > 1 ? `<h3 class="chart-title">${esc(M.label)} by person, last 14 days</h3>${ranked.map(r => `<div class="bar-row"><span>${esc(memberName(r.id))}</span><div class="bar" data-tip="${esc(`${memberName(r.id)}: ${M.fmt(r.v)}`)}"><span style="width:${r.v / rankTop * 100}%"></span></div><span>${esc(M.fmt(r.v))}</span></div>`).join('')}` : '';
  return `<p class="hint">The last 14 days.</p><div class="report-tiles">${tiles.map(([l, v]) => `<div class="report-tile"><b>${esc(String(v))}</b><span>${l}</span></div>`).join('')}</div>
    <div class="pills chart-metrics">${Object.entries(METRICS).map(([k, x]) => `<button class="pill" data-a="stats-metric" data-id="${k}" aria-pressed="${k === statsMetric}">${x.label}</button>`).join('')}</div>
    <h3 class="chart-title">${esc(who)}: ${esc(M.label.toLowerCase())} per day</h3>
    ${total ? `<div class="chart"><div class="chart-tip" id="chart-tip" hidden></div><div class="chart-plot">${ticks.map(v => `<div class="chart-grid" style="bottom:${v / top * 100}%"><span>${esc(M.fmt(v))}</span></div>`).join('')}<div class="chart-bars">${bars}</div></div><div class="chart-labels">${labels}</div></div>` : '<p class="empty">Nothing to show for the last 14 days.</p>'}
    ${compare}
    ${total ? `<details class="chart-table"><summary>Show as a table</summary><div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Day</th><th scope="col">${esc(M.label)}</th></tr></thead><tbody>${dates.map((d, i) => daily[i] ? `<tr><th scope="row">${esc(fmtShort(d))}</th><td>${esc(M.fmt(daily[i]))}</td></tr>` : '').join('')}</tbody></table></div></details>` : ''}`;
}
function showChartTip(el) {
  const tip = document.getElementById('chart-tip'); if (!tip) return;
  const box = tip.parentElement.getBoundingClientRect(), r = el.getBoundingClientRect();
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const w = tip.offsetWidth, x = Math.min(Math.max(0, r.left - box.left + r.width / 2 - w / 2), box.width - w);
  tip.style.left = x + 'px';
}
document.addEventListener('pointerover', e => { const b = e.target.closest && e.target.closest('.bar-col'); if (b) showChartTip(b); });
document.addEventListener('focusin', e => { if (e.target.classList && e.target.classList.contains('bar-col')) showChartTip(e.target); });
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('.bar-col'); if (b) showChartTip(b); });
document.addEventListener('pointerout', e => { if (e.target.closest && e.target.closest('.chart-plot') && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.chart-plot'))) { const t = document.getElementById('chart-tip'); if (t) t.hidden = true; } });
async function loadReport(id) {
  if (reportLoading) return; reportLoading = true;
  try { report = await call('GET', `logs/${encodeURIComponent(id)}`); } catch (e) { report = { error: e.message, memberId: id }; }
  reportLoading = false; scheduleRender();
}
function reportHTML() {
  if (!report || report.memberId !== logsWho) { loadReport(logsWho); return '<div class="empty">Loading their last 14 days…</div>'; }
  if (report.error) return `<div class="empty">${esc(report.error)}</div>`;
  const s = report.summary;
  const tiles = [['Chores done', s.chores], ['Estimated cleaning', fmtMins(s.minutes)], ['Delays', s.delays], ['Snoozes', s.snoozes], ['Sent back', s.sentBack], ['Chat messages', s.messages]];
  return `<div class="report-tiles">${tiles.map(([l, v]) => `<div class="report-tile"><b>${esc(String(v))}</b><span>${l}</span></div>`).join('')}</div>
    <div class="page-head" style="margin-top:12px"><h2 class="sec" style="margin:0">Last 14 days</h2><button class="btn small" data-a="report-csv">Download</button></div>
    ${report.items.length ? `<ul class="rows shifts">${report.items.map(i => `<li class="shift"><div><b>${esc(i.kind)}</b><span class="row-meta report-text">${esc(i.text)}</span></div><span class="log-time">${esc(stampText(i.at))}</span></li>`).join('')}</ul>` : '<p class="empty">Nothing in the last 14 days.</p>'}`;
}
function downloadReport() {
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ['Date,Time,Type,Details', ...report.items.map(i => [shiftDate(i.at), clockTime(i.at), i.kind, i.text].map(q).join(','))];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
  a.download = `family-planner-${(memberName(logsWho) || 'person').replace(/[^A-Za-z0-9]+/g, '-')}-last-14-days.csv`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function viewLogs() {
  if (!logsData) { loadLogs(); return '<div class="empty">Loading the logs…</div>'; }
  if (logsData.error) return `<div class="empty">${esc(logsData.error)}</div>`;
  const pick = id => logsWho === 'all' || id === logsWho;
  const signins = logsData.activity.filter(a => pick(a.memberId));
  const chores = logsData.chores.filter(c => pick(c.by) || pick(c.actor));
  const delays = (logsData.delays || []).filter(a => pick(a.memberId));
  const rows = logsTab === 'delays'
    ? delays.map(a => `<li class="shift"><div><b>${esc(a.detail.title)}</b><span class="row-meta">${esc(memberName(a.memberId) || a.name || 'Removed person')} delayed it until ${esc(clockTime(a.detail.until))}${a.detail.count > 1 ? ` · time ${a.detail.count} that day` : ''}${a.detail.reason ? `<br>Why: ${esc(a.detail.reason)}` : ''}</span></div><span class="log-time">${esc(stampText(a.at))}</span></li>`).join('')
    : logsTab === 'signins'
    ? signins.map(a => `<li class="shift"><div><b>${esc(memberName(a.memberId) || a.name || 'Removed person')}</b><span class="row-meta">${a.type === 'mode' ? `Switched to ${a.detail === 'admin' ? 'Admin' : 'Cleaner'} mode` : a.type === 'skip' ? `Skipped "${esc(a.detail.title)}" until next time` : a.type === 'review' ? `Checked "${esc(a.detail.title)}"` : a.type === 'ask-time' ? `Asked for extra time on ${esc(a.detail.device)}` : a.type === 'sick' ? `Logged as sick by ${esc(a.detail.by)}, chores paused for 12 hours` : a.type === 'sick-end' ? `No longer sick, ended by ${esc(a.detail.by)}` : esc(ACTIVITY[a.type] || a.type)}</span></div><span class="log-time">${esc(stampText(a.at))}</span></li>`).join('')
    : chores.map(c => { const by = memberName(c.by), actor = memberName(c.actor), sh = c.shiftId && S.shifts.get(c.shiftId);
        return `<li class="shift"><div><b>${esc(c.title)}</b>${c.extra ? '<span class="flag">Extra job</span>' : ''}<span class="row-meta">${esc(by || actor || 'Not credited')}${actor && actor !== by ? `, ticked by ${esc(actor)}` : ''}${sh ? ` · session from ${esc(clockTime(sh.start))}` : ''}</span>${c.rejected ? `<span class="row-note">Sent back by ${esc(c.rejected.by)}${c.rejected.note ? `: ${esc(c.rejected.note)}` : ''}</span>` : ''}</div><span class="log-side"><span class="log-time">${c.at ? esc(stampText(c.at)) : ''}</span>${c.rejected && c.rejected.photo ? `<button class="btn small" data-a="photo-view" data-id="${esc(c.rejected.photo)}">Photo</button>` : ''}${c.canReturn ? `<button class="btn small" data-a="send-back" data-id="${esc(c.id)}" data-title="${esc(c.title)}">Not done properly</button>` : ''}</span></li>`; }).join('');
  return `<div class="page-head"><div><h1>Logs</h1><p>${logsWho === 'all' ? 'Choose a person to see just their details.' : `${esc(memberName(logsWho))}'s last 14 days.`}</p></div><button class="btn" data-a="logs-refresh">Refresh</button></div>
    <div class="filters">${logsWho !== 'all' ? `<div class="pills"><button class="pill" data-a="logs-tab" data-id="report" aria-pressed="${!['hours', 'stats'].includes(logsTab)}">Last 14 days</button><button class="pill" data-a="logs-tab" data-id="hours" aria-pressed="${logsTab === 'hours'}">Hours</button><button class="pill" data-a="logs-tab" data-id="stats" aria-pressed="${logsTab === 'stats'}">Stats</button></div>` : `<div class="pills"><button class="pill" data-a="logs-tab" data-id="signins" aria-pressed="${logsTab === 'signins' || logsTab === 'report'}">Activity</button><button class="pill" data-a="logs-tab" data-id="chores" aria-pressed="${logsTab === 'chores'}">Chores</button><button class="pill" data-a="logs-tab" data-id="delays" aria-pressed="${logsTab === 'delays'}">Delays</button><button class="pill" data-a="logs-tab" data-id="hours" aria-pressed="${logsTab === 'hours'}">Hours</button><button class="pill" data-a="logs-tab" data-id="stats" aria-pressed="${logsTab === 'stats'}">Stats</button></div>`}
      <select id="logs-who" aria-label="Whose log" class="logs-who"><option value="all">Everyone</option>${members().map(m => `<option value="${esc(m.id)}" ${logsWho === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
    ${logsTab === 'hours' ? hoursHTML() : logsTab === 'stats' ? statsHTML() : logsWho !== 'all' ? reportHTML() : `${logsTab === 'delays' ? '<p class="hint">Each time someone pressed Delay 30 min on a chore.</p>' : logsTab === 'signins' ? '<p class="hint">People stay signed in for 90 days, so opening the app is logged too. Opening it again within 30 minutes is not repeated.</p>' : '<p class="hint">Times are when the chore was ticked. Undoing a tick removes its entry.</p>'}
    ${rows ? `<ul class="rows shifts">${rows}</ul>` : '<p class="empty">Nothing logged yet.</p>'}`}`;
}

/* Chat: one conversation for everyone signed in */
let chatDraft = '', chatStick = true;
const chatList = () => [...S.chat.values()].sort((a, b) => a.at - b.at);
function chatUnread() { const seen = +(pref('chat-seen') || 0); return chatList().filter(t => t.at > seen && t.memberId !== (me && me.id)).length; }
function updateChatBadge() { const b = document.getElementById('chat-badge'), n = me ? chatUnread() : 0; b.textContent = n || ''; b.hidden = !n; }
function markChatRead() { const l = chatList(), newest = l[l.length - 1]; if (newest && !document.hidden) { pref('chat-seen', String(newest.at)); updateChatBadge(); } }
function chatRows() {
  return chatList().map(m => {
    const mine = m.memberId === me.id;
    return `<li class="chat-msg ${mine ? 'mine' : ''} ${m.kind === 'sent-back' ? 'sent-back' : ''}"><div class="chat-bubble"><b>${esc(memberName(m.memberId) || m.name || 'Removed person')}</b><span class="chat-text">${esc(m.text)}</span>${m.photo ? `<button class="chat-pic" data-a="photo-view" data-id="${esc(m.photo)}" aria-label="See the picture"><img src="api/photos/${encodeURIComponent(m.photo)}" alt="Picture of the chore" loading="lazy"></button>` : ''}<span class="chat-meta">${esc(stampText(m.at))}${mine || me.admin ? ` · <button class="link chat-del" data-a="chat-del" data-id="${esc(m.id)}" aria-label="Delete this message">Delete</button>` : ''}</span></div></li>`;
  }).join('') || '<li class="empty">No messages yet.</li>';
}
function scrollChat() { const l = document.getElementById('chat-list'); if (l) l.scrollTop = l.scrollHeight; }
function refreshChatList() {
  const l = document.getElementById('chat-list'); if (!l) return;
  const atEnd = l.scrollHeight - l.scrollTop - l.clientHeight < 60;
  l.innerHTML = chatRows();
  if (atEnd) scrollChat();
  markChatRead();
}
/* Dinner: one entry a day, with no set time. Only days with something chosen are shown. */
const dinnerPlanned = d => !!d && (d.kind === 'takeaway' || d.kind === 'out' || !!d.group || !!d.meal);
function dinnerText(d) {
  if (d && d.kind === 'takeaway') return { title: d.meal ? `Takeaway night: ${d.meal}` : 'Takeaway night', who: '' };
  if (d && d.kind === 'out') return { title: d.meal ? `Eating out: ${d.meal}` : 'Eating out', who: '' };
  return { title: (d && d.meal) || 'Not decided yet', who: d && d.group ? (levelNames(d.group) ? `Cooking: ${levelNames(d.group)}` : 'Nobody in that group yet') : 'Nobody chosen to cook yet' };
}
function dinnerBanner() {
  const today = localToday(), d = S.dinners.get(today);
  if (!me || tabName() !== 'today' || !dinnerPlanned(d) || tripOn(today)) return '';
  const t = dinnerText(d);
  return `<div class="notice dinner-now"><span><b>Dinner tonight:</b> ${esc(t.title)}${t.who ? ` · ${esc(t.who)}` : ''}</span>${me.admin ? `<button class="btn small" data-a="dinner-open" data-id="${esc(today)}">Edit</button>` : ''}</div>`;
}
function viewDinner() {
  const today = localToday();
  const rows = [...S.dinners.values()].filter(d => d.id >= today && dinnerPlanned(d)).sort((a, b) => a.id < b.id ? -1 : 1).map(d => {
    const trip = tripOn(d.id), t = dinnerText(d);
    return `<li class="shift dinner-day"><div class="dinner-text"><span class="row-meta">${d.id === today ? 'Tonight' : esc(fmtShort(d.id))}</span><b>${esc(t.title)}</b>${t.who ? `<span class="row-meta">${esc(t.who)}</span>` : ''}${trip ? `<span class="row-meta">Family holiday: ${esc(trip.name)}</span>` : ''}${dinnerTaskRows(d.id)}</div>${me.admin ? `<div class="pills dinner-btns"><button class="btn small" data-a="dtask-new" data-id="${esc(d.id)}" aria-label="Add a reminder for dinner on ${esc(fmtShort(d.id))}">Add reminder</button><button class="btn small" data-a="dinner-open" data-id="${esc(d.id)}" aria-label="Edit dinner for ${esc(fmtShort(d.id))}">Edit</button></div>` : ''}</li>`;
  }).join('');
  return `${scheduleNav('dinner')}<div class="page-head"><div><h1>Dinner</h1><p>What's planned.</p></div>${me.admin ? '<button class="btn primary" data-a="dinner-new">Add dinner</button>' : ''}</div>${rows ? `<ul class="rows shifts">${rows}</ul>` : '<p class="empty">No dinners planned yet.</p>'}`;
}
function dinnerTaskRows(dinner) {
  const list = [...S.dinnerTasks.values()].filter(t => t.dinner === dinner).sort((a, b) => a.date < b.date ? -1 : 1);
  if (!list.length) return '';
  return `<ul class="dinner-tasks">${list.map(t => { const text = `${esc(t.text)}<span class="row-meta">${esc(fmtShort(t.date))}${levelNames(t.group) ? ` · ${esc(levelNames(t.group))}` : ''}</span>`; return `<li>${me.admin ? `<button class="dtask" data-a="dtask-open" data-id="${esc(t.id)}">${text}</button>` : text}</li>`; }).join('')}</ul>`;
}
function openDinnerTask(t) {
  const today = localToday(), first = t.date && t.date < today ? t.date : today;
  const opts = GROUPS.filter(n => (levels[n] || []).length || t.group === n);
  openSheet(`<form id="dtask-form" data-id="${esc(t.id || '')}" data-dinner="${esc(t.dinner)}"><h2 id="sheet-title">${t.id ? 'Edit reminder' : 'Add a reminder'}</h2><p class="hint">For dinner on ${esc(fmtShort(t.dinner))}.</p>
    <div class="field"><label class="lab" for="dt-text">What needs doing?</label><input type="text" id="dt-text" required maxlength="100" placeholder="Get the chicken out" autocomplete="off" value="${esc(t.text || '')}"></div>
    <div class="field"><label class="lab" for="dt-date">Date</label><input type="date" id="dt-date" required min="${esc(first)}" max="${esc(t.dinner)}" value="${esc(t.date || t.dinner)}"></div>
    <div class="field"><label class="lab" for="dt-group">Group</label><select id="dt-group" required><option value="">Choose a group</option>${opts.map(n => `<option value="${n}" ${t.group === n ? 'selected' : ''}>Group ${n}: ${esc(levelNames(n) || 'nobody yet')}</option>`).join('')}</select></div>
    <p class="form-error" id="dt-error" role="alert" hidden></p>
    <div class="actions">${t.id ? `<span class="left"><button type="button" class="btn danger" data-a="dtask-del" data-id="${esc(t.id)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
function openDinner(date) {
  const d = (date && S.dinners.get(date)) || {}, kind = d.kind || 'home', today = localToday();
  let first = today;
  while (dinnerPlanned(S.dinners.get(first))) first = addDays(first, 1);
  const pick = (v, label) => `<label class="inline-check"><input type="radio" name="dn-kind" value="${v}" ${kind === v ? 'checked' : ''}> ${label}</label>`;
  openSheet(`<form id="dinner-form" data-id="${esc(date || '')}"><h2 id="sheet-title">${date ? `Dinner, ${esc(fmtShort(date))}` : 'Add dinner'}</h2>
    ${date ? '' : `<div class="field"><label class="lab" for="dn-date">Day</label><input type="date" id="dn-date" required min="${esc(today)}" value="${esc(first)}"></div>`}
    <fieldset><legend>What's the plan?</legend>${pick('home', 'Cooking at home')}${pick('takeaway', 'Takeaway night')}${pick('out', 'Eating out')}</fieldset>
    <div class="field" id="dn-group-wrap" ${kind === 'home' ? '' : 'hidden'}><label class="lab" for="dn-group">Group cooking</label><select id="dn-group"><option value="0">Not chosen yet</option>${GROUPS.filter(n => (levels[n] || []).length || d.group === n).map(n => `<option value="${n}" ${d.group === n ? 'selected' : ''}>Group ${n}: ${esc(levelNames(n) || 'nobody yet')}</option>`).join('')}</select></div>
    <div class="field"><label class="lab" for="dn-meal">What we're having</label><input type="text" id="dn-meal" maxlength="80" autocomplete="off" value="${esc(d.meal || '')}"><p class="hint">Leave this blank and add it once you've decided.</p></div>
    <p class="form-error" id="dn-error" role="alert" hidden></p>
    <div class="actions">${date ? `<span class="left"><button type="button" class="btn danger" data-a="dinner-clear" data-id="${esc(date)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
const ASK_DEVICES = [['Mobile', '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>'], ['Tablet', '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 18h2"/>'], ['Xbox', '<rect x="2.5" y="7" width="19" height="11" rx="5"/><path d="M8 10.5v4M6 12.5h4M15.5 11.5h.01M18 13.5h.01"/>'], ['Laptop', '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 19h19"/>']];
function askRow(q) {
  const jobs = q.jobs.length ? `${q.jobs.length} ${q.jobs.length === 1 ? 'job' : 'jobs'} done: ${q.jobs.join(', ')}` : 'No jobs done';
  const state = q.answer ? `${q.answer === 'yes' ? 'Yes' : 'No'}, from ${q.answeredBy}` : 'Waiting for an answer';
  return `<li class="shift ask-row"><div class="dinner-text"><b>${me.admin ? `${esc(memberName(q.memberId) || q.name)}: ` : ''}${esc(q.device)}</b><span class="row-meta">Asked ${esc(stampText(q.at))}. In the 12 hours before: about ${esc(fmtMins(q.minutes))} of chores. ${esc(jobs)}.</span>${me.admin && !q.answer ? '' : `<span class="row-meta"><b>${esc(state)}</b></span>`}</div>${me.admin && !q.answer ? `<div class="pills"><button class="btn small primary" data-a="ask-yes" data-id="${esc(q.id)}">Yes</button><button class="btn small" data-a="ask-no" data-id="${esc(q.id)}">No</button></div>` : ''}</li>`;
}
function viewExtra() {
  const list = [...S.deviceAsks.values()].sort((a, b) => (!a.answer - !b.answer) * -1 || b.at - a.at);
  const asks = list.length ? `<ul class="rows shifts">${list.map(askRow).join('')}</ul>` : `<p class="empty">${me.admin ? 'No requests yet.' : 'You have not asked yet.'}</p>`;
  if (me.admin) return `<div class="page-head"><div><h1>Extra time</h1><p>Requests from the last 14 days.</p></div></div>${asks}`;
  return `<div class="page-head"><div><h1>Extra time</h1><p>Which device do you want extra time on? An admin will see the jobs you've done in the last 12 hours.</p></div></div>
    <div class="ask-devices">${ASK_DEVICES.map(([d, icon]) => `<button class="ask-device" data-a="ask-time" data-id="${d}"><svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>${d}</button>`).join('')}</div>
    <h2 class="sec" style="margin-top:28px">Your requests</h2>${asks}`;
}
let shopDraft = '';
const RECENT_ORDER_DAYS = 4;
let shopPending = '';
const sameItem = t => t.trim().toLowerCase().replace(/\s+/g, ' ');
/* Ignores capitals and extra spaces. Older orders are on the list for a while but don't count as recent. */
function shopWarning(text) {
  const same = [...S.shop.values()].filter(i => sameItem(i.text) === sameItem(text));
  const waiting = same.find(i => !i.ordered);
  if (waiting) return `${waiting.text} is already in the shopping list.`;
  const recent = same.filter(i => Date.now() - i.ordered.at < RECENT_ORDER_DAYS * 864e5).sort((a, b) => b.ordered.at - a.ordered.at)[0];
  return recent ? `${recent.text} was ordered recently, on ${stampText(recent.ordered.at)}.` : '';
}
async function shopAdd(text) {
  try { await call('POST', 'shop/items', { text }); shopDraft = ''; const n = document.getElementById('shop-text'); if (n) { n.value = ''; n.focus(); } }
  catch (err) { toast(err.message); }
}
function shopQty(i) {
  const n = i.qty || 1;
  if (i.ordered) return `<span class="shop-count" aria-label="Quantity ${n}">× ${n}</span>`;
  return `<div class="shop-qty" role="group" aria-label="Quantity of ${esc(i.text)}"><button class="btn small" data-a="shop-qty" data-id="${esc(i.id)}" data-n="-1" aria-label="One less ${esc(i.text)}" ${n <= 1 ? 'disabled' : ''}>−</button><span class="shop-count" aria-live="polite">${n}</span><button class="btn small" data-a="shop-qty" data-id="${esc(i.id)}" data-n="1" aria-label="One more ${esc(i.text)}" ${n >= 99 ? 'disabled' : ''}>+</button></div>`;
}
function shopRows() {
  const items = [...S.shop.values()].sort((a, b) => (!!a.ordered - !!b.ordered) || b.at - a.at);
  return items.map(i => `<li class="shift shop-item ${i.ordered ? 'is-ordered' : ''}">${me.admin ? `<label class="shop-tick"><input type="checkbox" data-shop="${esc(i.id)}" ${i.ordered ? 'checked' : ''} aria-label="Mark ${esc(i.text)} as ordered"></label>` : ''}<div class="shop-text"><b>${esc(i.text)}</b><span class="row-meta">Added by ${esc(i.by)}, ${esc(stampText(i.at))}${i.ordered ? ` · Ordered by ${esc(i.ordered.by)}, ${esc(stampText(i.ordered.at))}` : ''}</span></div>${shopQty(i)}${me.admin ? `<button class="btn small" data-a="shop-del" data-id="${esc(i.id)}" aria-label="Remove ${esc(i.text)}">Remove</button>` : ''}</li>`).join('') || '<li class="empty">Nothing on the list.</li>';
}
function viewShop() {
  return `<div class="page-head"><div><h1>Shopping list</h1><p>${me.admin ? 'Tick items as they are ordered. Ticked items delete themselves after 7 days.' : 'Ordered items delete themselves after 7 days.'}</p></div></div>
    <form id="shop-form" class="chat-form"><input type="text" id="shop-text" maxlength="80" placeholder="Add an item" aria-label="Add an item" autocomplete="off" value="${esc(shopDraft)}"><button class="btn primary">Add</button></form>
    <ul class="rows shifts" id="shop-list" style="margin-top:12px">${shopRows()}</ul>`;
}
function viewChat() {
  setTimeout(scrollChat);
  return `<div class="page-head chat-head"><div><h1>Chat</h1><p>Everyone with a sign-in can read this. Messages delete themselves after 14 days.</p></div></div>
    ${reminder && reminder.busy ? '<div class="notice"><span>You are at school, at work or away, so you won\'t get alerts for new messages.</span></div>' : ''}
    <ul class="chat-list" id="chat-list" aria-live="polite">${chatRows()}</ul>
    <form id="chat-form" class="chat-form"><textarea id="chat-text" rows="1" maxlength="1000" placeholder="Type a message" aria-label="Type a message">${esc(chatDraft)}</textarea><button class="btn primary">Send</button></form>`;
}
/* No alert during school or college times, work shifts and nights away: the message just waits in Chat. */
async function newChatMessage(id) {
  const t = S.chat.get(id); if (!t || !me || t.memberId === me.id) return;
  if (tabName() === 'chat' || document.hidden) return;
  try { reminder = await call('GET', 'reminders'); } catch (e) { /* use the last answer */ }
  if (reminder && reminder.busy) return;
  toast(`${memberName(t.memberId) || t.name || 'Someone'}: ${t.text.slice(0, 80)}${t.text.length > 80 ? '…' : ''}`);
}
document.addEventListener('input', e => { if (e.target.id === 'chat-text') chatDraft = e.target.value; if (e.target.id === 'shop-text') shopDraft = e.target.value; });
document.addEventListener('keydown', e => { if (e.target.id === 'chat-text' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); document.getElementById('chat-form').requestSubmit(); } });

let sys = null, sysLoading = false;
async function loadSystem() {
  if (sysLoading) return; sysLoading = true;
  try { sys = await call('GET', 'system/status'); } catch (e) { sys = { error: e.message }; }
  sysLoading = false; scheduleRender();
}
function viewSystem() {
  if (!sys) { loadSystem(); return '<div class="empty">Checking the system…</div>'; }
  if (sys.error) return `<div class="empty">${esc(sys.error)}</div>`;
  const back = sys.releases[0];
  const label = { success: 'Installed', 'rolled-back': 'Failed, previous version restored', failed: 'Failed', running: 'In progress' };
  return `<div class="page-head"><div><h1>System</h1><p>Family Planner version ${esc(sys.version)}</p></div>
      <div class="pills">${sys.ready ? `<button class="btn primary" data-a="sys-upload">Upload update</button>${back ? `<button class="btn" data-a="sys-back">Go back to ${esc(back.version)}</button>` : ''}` : ''}</div></div>
    ${sys.ready ? '' : `<div class="notice"><span>The update helper isn't set up on this server yet, so updates can't be installed from here.</span></div>`}
    <h2 class="sec">Backup</h2><p class="hint">Downloads one file with all chores, logs, chat, photos and accounts to this device. It includes private family details, so keep it somewhere safe.</p>
    <a class="btn" id="backup-link" href="api/system/backup" download>Download backup</a>
    <p class="hint" style="margin:10px 0 28px">${sys.lastBackup ? `Last backup: ${esc(stampText(sys.lastBackup.at))} by ${esc(sys.lastBackup.by)}` : 'No backup downloaded yet.'}</p>
    <h2 class="sec">Update history</h2><p class="hint">The last 4 updates.</p>
    ${sys.history.length ? `<ul class="rows shifts">${sys.history.map(h => `<li class="shift"><div><b>${h.action === 'rollback' ? 'Went back to' : 'Updated to'} ${esc(h.to)}</b><span class="row-meta">${esc(fmtShort(shiftDate(h.at)))}, ${esc(clockTime(h.at))} · ${esc(h.by)} · from ${esc(h.from)} · ${esc(label[h.result] || h.result)}</span></div></li>`).join('')}</ul>` : '<p class="empty">No updates yet.</p>'}`;
}
function householdHTML() {
  if (!me.admin) return `<ul class="mini">${members().map(m => `<li><span>${esc(m.name)}</span></li>`).join('')}</ul><p class="hint">A household admin can add people and sign-ins.</p>`;
  return members().map(m => {
    const l = logins[m.id];
    const status = l ? `${esc(l.username)}${roleNames(l) ? ' · ' + esc(roleNames(l)) : ''}` : 'In the planner, no sign-in';
    const locked = l && l.system && !me.system;
    return `<div class="person"><div class="member"><input type="text" id="member-${esc(m.id)}" data-member="${esc(m.id)}" value="${esc(m.name)}" aria-label="Name of ${esc(m.name)}">
      ${m.id === me.id || locked ? '' : `<button class="btn" data-a="member-del-ask" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">Remove</button>`}</div>
      <div class="person-sub"><span>${status}</span>${locked ? '' : `<button class="link" data-a="login-open" data-id="${esc(m.id)}">${l ? 'Change sign-in' : 'Give a sign-in'}</button>`}</div></div>`;
  }).join('') + `<form id="member-form" class="member"><input type="text" id="member-new" placeholder="Add a name" aria-label="Add a name" autocomplete="off"><button class="btn primary">Add</button></form>`;
}
function signInHTML() {
  return `<form id="signin-form" class="setup signin"><h1>Sign in</h1>
    <div class="field"><label class="lab" for="si-user">Email</label><input type="text" inputmode="email" id="si-user" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
    <div class="field"><label class="lab" for="si-pass">Password</label><input type="password" id="si-pass" autocomplete="current-password" required></div>
    <p class="form-error" id="si-error" role="alert" hidden></p>
    <div class="actions"><button class="btn primary" id="si-go">Sign in</button></div>
    <p class="hint">Forgotten your password? Ask your household admin to set a new one.</p></form>
    <section class="whats-on" id="whats-on" aria-label="What's on">${whatsOnHTML()}</section>`;
}
function setupHTML(first) {
  const names = Object.keys(ROOM_TEMPLATES);
  const on = ['Kitchen', 'Bathroom', 'Living room', 'Bedroom'];
  return `<form id="setup-form" class="setup">
    ${first ? `<h1>Set up your home</h1><p>Choose your rooms and get a ready-made cleaning routine. You can change everything afterwards.</p>` : `<h2 id="sheet-title">Add from templates</h2><p class="hint">Chores you already have won't be added twice.</p>`}
    <fieldset><legend>Rooms</legend><div class="checks">${names.map((n, i) => `<label class="check"><input type="checkbox" id="setup-room-${i}" name="room" value="${esc(n)}" ${first && on.includes(n) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')}</div></fieldset>
    <fieldset><legend>Also include</legend><div class="checks">
      <label class="check"><input type="checkbox" id="setup-pets" name="pets"><span>Pets</span></label>
      <label class="check"><input type="checkbox" id="setup-kids" name="kids"><span>Children</span></label></div></fieldset>
    ${first ? `<div class="field"><label class="lab" for="setup-names">Who lives here?</label><input type="text" id="setup-names" placeholder="Separate names with commas" autocomplete="off"><div class="hint">Add anyone besides you. Chores get shared out between you all, and you can give them sign-ins afterwards.</div></div>` : ''}
    <div class="actions">${first ? '' : '<button type="button" class="btn" data-a="close">Cancel</button>'}<button class="btn primary" id="setup-go">${first ? 'Build my planner' : 'Add chores'}</button></div></form>`;
}

/* ---------- sheets ---------- */
const sheet = document.getElementById('sheet');
function openSheet(html) { sheet.innerHTML = html; if (!sheet.open) sheet.showModal(); }
function closeSheet() { if (sheet.open) sheet.close(); sheet.innerHTML = ''; }
function choreForm(c, isNew) {
  const rs = rooms(), ms = members();
  const opts = [5, 10, 15, 20, 30, 45, 60, 90, 120]; if (c.minutes && !opts.includes(c.minutes)) opts.push(c.minutes), opts.sort((a, b) => a - b);
  return `<form id="chore-form" data-id="${esc(c.id || '')}">
    <h2 id="sheet-title">${isNew ? 'Add a chore' : 'Edit chore'}</h2>
    <div class="field"><label class="lab" for="f-title">What needs doing?</label><input type="text" id="f-title" required maxlength="120" value="${esc(c.title || '')}" autocomplete="off"></div>
    <div class="two">
      <div class="field"><label class="lab" for="f-room">Room</label><select id="f-room">${rs.map(r => `<option value="${esc(r.id)}" ${r.id === c.roomId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      <div class="field"><label class="lab" for="f-minutes">Takes about</label><select id="f-minutes">${opts.map(m => `<option value="${m}" ${m === (c.minutes || 15) ? 'selected' : ''}>${fmtMins(m)}</option>`).join('')}</select></div></div>
    <div class="two">
      <div class="field"><label class="lab" for="f-unit">Repeats</label><select id="f-unit">
        ${[['once', "Doesn't repeat"], ['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly']].map(([v, l]) => `<option value="${v}" ${(c.unit || 'week') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field" id="f-every-wrap"><label class="lab" for="f-every">Every</label><input type="number" id="f-every" min="1" max="99" value="${c.every || 1}"></div></div>
    <div class="two"><div class="field"><label class="lab" for="f-due">${isNew ? 'First due' : 'Next due'}</label><input type="date" id="f-due" required value="${esc(c.due || localToday())}"></div>
      <div class="field"><label class="lab" for="f-time">Time (optional)</label><input type="time" id="f-time" value="${esc(c.time || '')}"></div></div>
    <div class="field" id="f-basis-wrap"><label class="lab" for="f-basis">Next time counts from</label><select id="f-basis">
      <option value="fixed" ${c.basis === 'fixed' ? 'selected' : ''}>The calendar, like bin day</option>
      <option value="floating" ${c.basis !== 'fixed' ? 'selected' : ''}>The day I last did it</option></select><div class="hint" id="f-hint"></div></div>
    ${ms.length ? `<div class="field"><label class="lab" for="f-assignee">Main person</label><select id="f-assignee"><option value="">Anyone: one person does it</option><option value="__everyone" ${c.everyone && !(c.people || []).length ? 'selected' : ''}>Everyone: each cleaner does it</option><option value="__pick" ${(c.people || []).length ? 'selected' : ''}>Choose people: tick who it applies to</option>${GROUPS.filter(n => (levels[n] || []).length || c.anyLevel === n).map(n => `<option value="__any${n}" ${c.anyLevel === n ? 'selected' : ''}>Anyone in group ${n}: ${esc(levelNames(n) || 'nobody yet')}</option>`).join('')}${GROUPS.filter(n => (levels[n] || []).length || c.level === n).map(n => `<option value="__level${n}" ${c.level === n ? 'selected' : ''}>Group ${n} takes turns: ${esc(levelNames(n) || 'nobody yet')}</option>`).join('')}${ms.map(m => `<option value="${esc(m.id)}" ${m.id === c.assignee && !c.everyone && !c.level && !c.anyLevel ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      ${ms.length > 1 ? `<label class="inline-check" id="f-rotate-wrap"><input type="checkbox" id="f-rotate" ${c.rotate && !c.level ? 'checked' : ''}> Take turns after each time it's done</label>` : ''}</div>
    <fieldset id="f-people-wrap" hidden><legend>Who it applies to</legend><div class="checks">${[...new Set(GROUPS.flatMap(n => levels[n] || []))].map(id => S.members.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map(m => `<label class="check"><input type="checkbox" name="f-person" value="${esc(m.id)}" ${(c.people || []).includes(m.id) ? 'checked' : ''}><span>${esc(m.name)}</span></label>`).join('')}</div><div class="hint">Each person ticked does it. It's finished when they all have.</div></fieldset>
    <div class="field" id="f-backup-wrap"><label class="lab" for="f-backup">Second person, when the main person is away</label><select id="f-backup"><option value="">Nobody: move it to the next day</option>${GROUPS.filter(n => (levels[n] || []).length || c.backupGroup === n).map(n => `<option value="__group${n}" ${c.backupGroup === n ? 'selected' : ''}>Group ${n}: ${esc(levelNames(n) || 'nobody yet')}</option>`).join('')}${ms.map(m => `<option value="${esc(m.id)}" ${m.id === c.backup ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>` : ''}
    <div class="field"><label class="lab" for="f-notes">Notes</label><textarea id="f-notes" rows="2" maxlength="500">${esc(c.notes || '')}</textarea></div>
    <div class="actions">
      ${isNew ? '' : `<span class="left"><button type="button" class="btn" data-a="skip" data-id="${esc(c.id)}">Skip this time</button><button type="button" class="btn danger" data-a="del-ask" data-id="${esc(c.id)}">Delete</button></span>`}
      <button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`;
}
function syncChoreForm() {
  const u = document.getElementById('f-unit'); if (!u) return;
  const who = document.getElementById('f-assignee')?.value, bw = document.getElementById('f-backup-wrap');
  if (bw) bw.hidden = !who || who === '__everyone' || who === '__pick' || who.startsWith('__any');
  const pw = document.getElementById('f-people-wrap'); if (pw) pw.hidden = who !== '__pick';
  const rw = document.getElementById('f-rotate-wrap'); if (rw) rw.hidden = !who || who.startsWith('__');
  const once = u.value === 'once';
  document.getElementById('f-every-wrap').hidden = once;
  document.getElementById('f-basis-wrap').hidden = once;
  const due = document.getElementById('f-due').value, basis = document.getElementById('f-basis').value, n = +document.getElementById('f-every').value || 1;
  const hint = document.getElementById('f-hint');
  if (hint && due && !once) {
    const c = { unit: u.value, every: n, basis, due, dom: toD(due).getUTCDate() };
    hint.textContent = `${repeatText(c)}. ${basis === 'fixed' ? `After ${fmtShort(due)}, next is ${fmtShort(step(c, due))}.` : `If done on the day, next is ${fmtShort(step(c, due))}.`}`;
  }
}

/* ---------- events ---------- */
let toastTimer;
function toast(text, undo) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(text)}</span>${undo ? '<button id="toast-undo">Undo</button>' : ''}`;
  t.hidden = false;
  if (undo) document.getElementById('toast-undo').onclick = () => { t.hidden = true; undo(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}
const NOT_FOR_CLEANERS = new Set(['swap-open', 'new', 'edit', 'skip', 'del-ask', 'del', 'templates', 'room-new', 'room-edit', 'room-del-ask', 'room-del']);
document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a, id = b.dataset.id;
  if (me && !me.admin && NOT_FOR_CLEANERS.has(a)) { if (a === 'edit') { const c = S.chores.get(id); if (c) openChoreInfo(c); } else toast('Only a household admin can change chores.'); return; }
  if (a === 'done') complete(id);
  else if (a === 'done-for') { closeSheet(); complete(id, undefined, b.dataset.who); }
  else if (a === 'later') delayOpen(id);
  else if (a === 'undo') undoLog(id);
  else if (a === 'who') { who = id; pref('who', id); scheduleRender(); }
  else if (a === 'wk') { weekStart = +id === 0 ? null : addDays(weekStart || mondayOf(localToday()), +id); scheduleRender(); }
  else if (a === 'new') { openSheet(choreForm({ due: b.dataset.date || localToday(), roomId: b.dataset.room || rooms()[0]?.id, basis: 'floating', unit: 'week', every: 1, minutes: 15, assignee: who !== 'all' ? who : '' }, true)); syncChoreForm(); }
  else if (a === 'edit') { const c = S.chores.get(id); if (c) { openSheet(choreForm(c, false)); syncChoreForm(); } }
  else if (a === 'close') closeSheet();
  else if (a === 'skip') { closeSheet(); skip(id); }
  else if (a === 'del-ask') { b.outerHTML = `<button type="button" class="btn danger" data-a="del" data-id="${esc(id)}">Yes, delete it</button>`; }
  else if (a === 'del') { const c = S.chores.get(id); closeSheet(); del('chores', id); if (c) toast(`${c.title} deleted.`, () => put('chores', c)); }
  else if (a === 'templates') openSheet(setupHTML(false));
  else if (a === 'room-new') openRoom({});
  else if (a === 'room-edit') openRoom(S.rooms.get(id));
  else if (a === 'room-del-ask') { const n = allChores().filter(c => c.roomId === id).length; b.outerHTML = `<button type="button" class="btn danger" data-a="room-del" data-id="${esc(id)}">Yes, delete the room${n ? ` and ${n} ${n === 1 ? 'chore' : 'chores'}` : ''}</button>`; }
  else if (a === 'room-del') { closeSheet(); (async () => { for (const c of [...S.chores.values()].filter(c => c.roomId === id)) await del('chores', c.id); await del('rooms', id); })(); }
  else if (a === 'member-del-ask') { b.outerHTML = `<button class="btn danger" data-a="member-del" data-id="${esc(id)}">Yes, remove</button>`; }
  else if (a === 'member-del') { if (who === id) { who = 'all'; pref('who', 'all'); } call('DELETE', `members/${id}`).catch(writeFailed); }
  else if (a === 'login-open') openLogin(id);
  else if (a === 'groups-all') { groupsShowAll = true; scheduleRender(); }
  else if (a === 'login-del') { closeSheet(); call('DELETE', `members/${id}/login`).then(() => toast('Sign-in removed.')).catch(writeFailed); }
  else if (a === 'pw-open') openPassword();
  else if (a === 'sign-out') { (pushSub ? call('POST', 'push/unsubscribe', { endpoint: pushSub.endpoint }).catch(() => {}) : Promise.resolve()).then(() => call('POST', 'logout')).catch(() => {}).finally(() => { pushInfo = null; showSignedOut(); }); }
  else if (a === 'mode-set') { if (me.mode !== id) call('POST', 'mode', { mode: id }).then(() => { logsData = null; return refresh(); }).then(() => toast(id === 'admin' ? 'Admin mode.' : 'Cleaner mode.')).catch(writeFailed); }
  else if (a === 'logs-tab') { logsTab = id; scheduleRender(); }
  else if (a === 'logs-refresh') { logsData = null; report = null; stats = null; scheduleRender(); }
  else if (a === 'stats-metric') { statsMetric = id; scheduleRender(); }
  else if (a === 'ar-save') { const box = document.getElementById(`ar-${id}`); call('PUT', `away-reasons/${encodeURIComponent(id)}`, { name: box.value }).then(() => toast('Reason saved.')).catch(writeFailed); }
  else if (a === 'ar-del') call('DELETE', `away-reasons/${encodeURIComponent(id)}`).catch(writeFailed);
  else if (a === 'ask-time') call('POST', 'device-asks', { device: id }).then(() => toast(`Sent. An admin has been asked about your ${id}.`)).catch(e => toast(e.message));
  else if (a === 'ask-yes' || a === 'ask-no') call('POST', `device-asks/${encodeURIComponent(id)}/answer`, { yes: a === 'ask-yes' }).catch(writeFailed);
  else if (a === 'out-open') openOuting(S.outings.get(id) || {});
  else if (a === 'out-del') { closeSheet(); call('DELETE', `outings/${encodeURIComponent(id)}`).catch(writeFailed); }
  else if (a === 'extra-open') openExtraJob();
  else if (a === 'sick-new') openSick();
  else if (a === 'sick-again') call('POST', `sick/${encodeURIComponent(id)}`).then(() => toast('Paused for another 12 hours.')).catch(writeFailed);
  else if (a === 'sick-end') call('DELETE', `sick/${encodeURIComponent(id)}`).then(() => toast('Chores are back on.')).catch(writeFailed);
  else if (a === 'night-new') openNight({});
  else if (a === 'night-open') openNight(S.nights.get(id) || {});
  else if (a === 'night-del') { closeSheet(); call('DELETE', `nights/${encodeURIComponent(id)}`).catch(writeFailed); }
  else if (a === 'nt-del') call('DELETE', `night-types/${encodeURIComponent(id)}`).catch(writeFailed);
  else if (a === 'app-install') installApp();
  else if (a === 'dinner-open') openDinner(id);
  else if (a === 'dinner-new') openDinner();
  else if (a === 'dtask-new') openDinnerTask({ dinner: id });
  else if (a === 'dtask-open') { const t = S.dinnerTasks.get(id); if (t) openDinnerTask(t); }
  else if (a === 'dtask-del') { closeSheet(); call('DELETE', `d/dinnerTasks/${encodeURIComponent(id)}`).catch(writeFailed); }
  else if (a === 'dinner-clear') { closeSheet(); call('DELETE', `d/dinners/${encodeURIComponent(id)}`).catch(writeFailed); }
  else if (a === 'shop-qty') call('POST', `shop/items/${encodeURIComponent(id)}/qty`, { delta: +b.dataset.n }).catch(writeFailed);
  else if (a === 'shop-del') call('DELETE', `shop/items/${encodeURIComponent(id)}`).catch(writeFailed);
  else if (a === 'push-on') pushOn();
  else if (a === 'push-off') pushOff();
  else if (a === 'push-test') pushTest();
  else if (a === 'review-ok') { b.disabled = true; call('POST', `reviews/${encodeURIComponent(id)}/accept`).then(() => toast('Accepted, and the pictures have been deleted.')).catch(writeFailed); }
  else if (a === 'review-no') openReviewReject(id);
  else if (a === 'whats-new') openChanges();
  else if (a === 'swap-open') openSwap(id);
  else if (a === 'swap-reset') { const c = S.chores.get(id); if (c) { const n = { ...c }; delete n.once; closeSheet(); put('chores', n); toast('Back with the main person.'); } }
  else if (a === 'trip-open') openTrip(S.trips.get(id) || {});
  else if (a === 'trip-del-ask') { b.outerHTML = `<button type="button" class="btn danger" data-a="trip-del" data-id="${esc(id)}">Yes, delete it</button>`; }
  else if (a === 'trip-del') { closeSheet(); del('trips', id); }
  else if (a === 'event-open') { if (String(id).startsWith('night:')) location.hash = '#fun'; else if (String(id).startsWith('dinner:')) location.hash = '#dinner'; else if (String(id).startsWith('away:')) { const aw = S.away.get(String(id).slice(5)); if (me.admin && aw) openOuting(awayForm(aw)); else location.hash = '#school'; } else if (String(id).startsWith('out:')) openOuting(S.outings.get(String(id).slice(4)) || {}); else openEvent(S.events.get(id) || {}); }
  else if (a === 'event-del-ask') { b.outerHTML = `<button type="button" class="btn danger" data-a="event-del" data-id="${esc(id)}">Yes, delete it</button>`; }
  else if (a === 'event-del') { closeSheet(); del('events', id); }
  else if (a === 'remind-snooze') { call('POST', 'reminders/snooze', { which: id }).then(queueReminders).then(() => toast('Snoozed for 1 hour.')).catch(writeFailed); }
  else if (a === 'report-csv') downloadReport();
  else if (a === 'send-back') openSendBack(id, b.dataset.title);
  else if (a === 'job-check') call('POST', `log/${id}/check`, { yes: !!b.dataset.yes }).then(() => toast(b.dataset.yes ? 'Approved.' : 'Rejected.')).catch(writeFailed);
  else if (a === 'photo-view') openSheet(`<div><h2 id="sheet-title">Photo</h2><img class="chore-photo" src="api/photos/${encodeURIComponent(id)}" alt="Photo added when this chore was sent back"><div class="actions"><button type="button" class="btn" data-a="close">Close</button></div></div>`);
  else if (a === 'chat-del') { call('DELETE', `chat/${encodeURIComponent(id)}`).catch(writeFailed); }
  else if (a === 'shift-del-ask') { b.outerHTML = `<button type="button" class="btn danger" data-a="shift-del" data-id="${esc(id)}">Yes, delete it</button>`; }
  else if (a === 'shift-del') { closeSheet(); call('DELETE', `shifts/${encodeURIComponent(id)}`).then(() => toast('Session deleted.')).catch(writeFailed); }
  else if (a === 'work-open') openWork(S.work.get(id) || (b.dataset.date ? { date: b.dataset.date } : {}));
  else if (a === 'cal-move') { const base = (calMonth || localToday().slice(0, 7)) + '-15'; calMonth = addDays(base, +id * 30).slice(0, 7); scheduleRender(); }
  else if (a === 'cal-day') openDay(id);
  else if (a === 'away-open') openOuting(S.away.get(id) ? awayForm(S.away.get(id)) : { from: b.dataset.date, handover: true });
  else if (a === 'away-del-ask') { b.outerHTML = `<button type="button" class="btn danger" data-a="away-del" data-id="${esc(id)}">Yes, delete it</button>`; }
  else if (a === 'away-del') { closeSheet(); del('away', id); }
  else if (a === 'app-update') location.reload();
  else if (a === 'work-del-ask') { b.outerHTML = `<button type="button" class="btn danger" data-a="work-del" data-id="${esc(id)}">Yes, delete it</button>`; }
  else if (a === 'work-del') { closeSheet(); del('work', id); }
  else if (a === 'sched-open') openSchedule(id);
  else if (a === 'sched-copy') copyMonday();
  else if (a === 'sched-del') { closeSheet(); del('schedules', id); }
  else if (a === 'hol-open') openHoliday(S.holidays.get(id) || {});
  else if (a === 'hol-del-ask') { b.outerHTML = `<button type="button" class="btn danger" data-a="hol-del" data-id="${esc(id)}">Yes, delete it</button>`; }
  else if (a === 'hol-del') { closeSheet(); del('holidays', id); }
  else if (a === 'sys-upload') openUpload();
  else if (a === 'sys-back') openGoBack();
  else if (a === 'sys-cancel') { closeSheet(); call('POST', 'system/cancel').catch(() => {}); }
});
function openChoreInfo(c) {
  openSheet(`<div><h2 id="sheet-title">${esc(c.title)}</h2>
    <p class="row-meta">${c.time ? `${esc(c.time)} · ` : ''}${esc(roomName(c.roomId))} · about ${esc(fmtMins(c.minutes || 0))} · ${esc(repeatText(c))}</p>
    ${c.notes ? `<p style="white-space:pre-wrap">${esc(c.notes)}</p>` : ''}
    <div class="actions"><button type="button" class="btn" data-a="close">Close</button></div></div>`);
}
function openWork(w) {
  openSheet(`<form id="work-form" data-id="${esc(w.id || '')}"><h2 id="sheet-title">${w.id ? 'Edit work shift' : 'Log a work shift'}</h2>
    <div class="field"><label class="lab" for="wk-person">Who it's for</label><select id="wk-person" required><option value="" ${w.memberId ? '' : 'selected'} disabled>Choose a person</option>${members().map(m => `<option value="${esc(m.id)}" ${m.id === w.memberId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
    <div class="field"><label class="lab" for="wk-date">Date it starts</label><input type="date" id="wk-date" required value="${esc(w.date || localToday())}"></div>
    <div class="two"><div class="field"><label class="lab" for="wk-start">Start</label><input type="time" id="wk-start" required value="${esc(w.start || '')}"></div>
    <div class="field"><label class="lab" for="wk-end">Finish</label><input type="time" id="wk-end" required value="${esc(w.end || '')}"></div></div>
    <p class="hint">For a night shift, enter a finish time earlier than the start. It counts as finishing the next day.</p>
    <div class="field"><label class="lab" for="wk-note">Where or what (optional)</label><input type="text" id="wk-note" maxlength="80" value="${esc(w.note || '')}" autocomplete="off"></div>
    <p class="form-error" id="wk-error" role="alert" hidden></p>
    <div class="actions">${w.id ? `<span class="left"><button type="button" class="btn danger" data-a="work-del-ask" data-id="${esc(w.id)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
function openSchedule(id) {
  const m = S.members.get(id); if (!m) return;
  const sc = S.schedules.get(id) || { place: 'School', days: {} };
  openSheet(`<form id="sched-form" data-id="${esc(id)}"><h2 id="sheet-title">${esc(m.name)}'s times</h2>
    <div class="field"><label class="lab" for="sc-place">School or college</label><input type="text" id="sc-place" maxlength="40" list="sc-places" value="${esc(sc.place)}" autocomplete="off"><datalist id="sc-places"><option value="School"><option value="College"></datalist></div>
    ${DAY_NAMES.map((n, i) => { const d = i + 1, t = sc.days[d]; return `<div class="sched-row"><label class="inline-check"><input type="checkbox" id="sc-on-${d}" ${t ? 'checked' : ''}> ${n}</label><input type="time" id="sc-start-${d}" aria-label="${n} start" value="${esc(t ? t.start : '08:30')}"><input type="time" id="sc-end-${d}" aria-label="${n} finish" value="${esc(t ? t.end : '15:15')}"></div>`; }).join('')}
    <button type="button" class="link" data-a="sched-copy">Use Monday's times for Tuesday to Friday</button>
    <p class="form-error" id="sc-error" role="alert" hidden></p>
    <div class="actions">${S.schedules.has(id) ? `<span class="left"><button type="button" class="btn danger" data-a="sched-del" data-id="${esc(id)}">Remove</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
function copyMonday() {
  const g = id => document.getElementById(id);
  for (let d = 2; d <= 5; d++) { g(`sc-on-${d}`).checked = g('sc-on-1').checked; g(`sc-start-${d}`).value = g('sc-start-1').value; g(`sc-end-${d}`).value = g('sc-end-1').value; }
}
function openTrip(t) {
  const today = localToday();
  openSheet(`<form id="trip-form" data-id="${esc(t.id || '')}"><h2 id="sheet-title">${t.id ? 'Edit family holiday' : 'Add a family holiday'}</h2>
    <p class="hint">For when everyone is away and nobody is home. There's no schedule or alerts, and chores wait until the day after. If you're home for the school holidays, add a school holiday instead.</p>
    <div class="field"><label class="lab" for="tr-name">Name</label><input type="text" id="tr-name" required maxlength="60" placeholder="Spain" value="${esc(t.name || '')}" autocomplete="off"></div>
    <div class="two"><div class="field"><label class="lab" for="tr-from">First day</label><input type="date" id="tr-from" required value="${esc(t.from || today)}"></div>
    <div class="field"><label class="lab" for="tr-to">Last day</label><input type="date" id="tr-to" required value="${esc(t.to || t.from || today)}"></div></div>
    <p class="form-error" id="tr-error" role="alert" hidden></p>
    <div class="actions">${t.id ? `<span class="left"><button type="button" class="btn danger" data-a="trip-del-ask" data-id="${esc(t.id)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
function openHoliday(h) {
  const today = localToday();
  openSheet(`<form id="hol-form" data-id="${esc(h.id || '')}"><h2 id="sheet-title">${h.id ? 'Edit school holiday' : 'Add a school holiday'}</h2>
    <p class="hint">During a holiday, school times are hidden and chore reminders carry on through what would be school hours.</p>
    <div class="field"><label class="lab" for="hl-name">Name</label><input type="text" id="hl-name" required maxlength="60" placeholder="Half term" value="${esc(h.name || '')}" autocomplete="off"></div>
    <div class="two"><div class="field"><label class="lab" for="hl-from">First day</label><input type="date" id="hl-from" required value="${esc(h.from || today)}"></div>
    <div class="field"><label class="lab" for="hl-to">Last day</label><input type="date" id="hl-to" required value="${esc(h.to || h.from || today)}"></div></div>
    <fieldset><legend>Who it's for</legend><div class="checks">${members().map(m => `<label class="check"><input type="checkbox" name="hol-person" value="${esc(m.id)}" ${(h.people || []).includes(m.id) ? 'checked' : ''}><span>${esc(m.name)}</span></label>`).join('')}</div><div class="hint">Leave these unticked to apply it to everyone.</div></fieldset>
    <p class="form-error" id="hl-error" role="alert" hidden></p>
    <div class="actions">${h.id ? `<span class="left"><button type="button" class="btn danger" data-a="hol-del-ask" data-id="${esc(h.id)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
function openUpload() {
  openSheet(`<form id="up-form"><h2 id="sheet-title">Upload update</h2>
    <div class="field"><label class="lab" for="up-file">Update package</label><input type="file" id="up-file" required accept=".gz,.tgz,application/gzip"><div class="hint">The .tar.gz package. It's checked before anything is installed.</div></div>
    <p class="form-error" id="up-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary" id="up-go">Check package</button></div></form>`);
}
function openGoBack() {
  const back = sys.releases[0];
  openSheet(`<form id="back-form"><h2 id="sheet-title">Go back to ${esc(back.version)}</h2>
    <p>This restores the app files from version ${esc(back.version)} and keeps your current data.</p>
    <div class="field"><label class="lab" for="bk-pass">Your password</label><input type="password" id="bk-pass" required autocomplete="current-password"></div>
    <p class="form-error" id="bk-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Go back</button></div></form>`);
}
async function waitForUpdate(id) {
  openSheet(`<div><h2 id="sheet-title">Installing…</h2><p>Family Planner restarts during this. Keep this page open. It usually takes under a minute.</p></div>`);
  const started = Date.now();
  while (Date.now() - started < 180000) {
    await new Promise(r => setTimeout(r, 2500));
    try {
      const res = await fetch('api/system/status', { credentials: 'same-origin' });
      if (!res.ok) continue;
      const st = await res.json();
      if (st.state !== 'running' && st.last && st.last.id === id) {
        if (st.last.result === 'success') { location.reload(); return; }
        sys = st; scheduleRender();
        openSheet(`<div><h2 id="sheet-title">That didn't install</h2><p>${esc(st.last.message || 'The update failed.')}</p><div class="actions"><button type="button" class="btn" data-a="close">Close</button></div></div>`);
        return;
      }
    } catch (e) { /* the app is restarting */ }
  }
  openSheet(`<div><h2 id="sheet-title">Still waiting</h2><p>The update hasn't reported back after 3 minutes. Check the System tab, or the server if the page won't load.</p><div class="actions"><button type="button" class="btn" data-a="close">Close</button></div></div>`);
}
function openSendBack(id, title) {
  openSheet(`<form id="back-chore-form" data-id="${esc(id)}"><h2 id="sheet-title">Send back: ${esc(title)}</h2>
    <p class="hint">This unticks it and puts it back where it was scheduled, with the same person.</p>
    <div class="field"><label class="lab" for="bc-note">What needs fixing?</label><textarea id="bc-note" rows="3" maxlength="500"></textarea></div>
    <div class="field"><label class="lab" for="bc-photo">Take a picture (optional)</label><input type="file" id="bc-photo" accept="image/*" capture="environment"><div class="hint">On a phone this opens the camera. The picture is deleted when the job is done again.</div></div>
    <label class="inline-check bc-need"><input type="checkbox" id="bc-need"> Ask for a picture when it's redone, so I can check it</label>
    <p class="form-error" id="bc-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary" id="bc-go">Send back</button></div></form>`);
}
/* Photos are shrunk on the device and saved as new JPEGs, which also removes location data. */
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise(ok => canvas.toBlob(ok, 'image/jpeg', 0.75));
  } finally { URL.revokeObjectURL(url); }
}
async function uploadPhoto(file) {
  let blob;
  try { blob = await shrinkPhoto(file); } catch (e) { throw new Error("That picture couldn't be opened. Try a different one."); }
  if (!blob) throw new Error("That picture couldn't be opened. Try a different one.");
  const bytes = new Uint8Array(await blob.arrayBuffer()), size = 40 * 1024, total = Math.max(1, Math.ceil(bytes.length / size)), upload = 'p' + uid();
  let out = null;
  for (let i = 0; i < total; i++) {
    let bin = ''; for (const b of bytes.subarray(i * size, (i + 1) * size)) bin += String.fromCharCode(b);
    out = await call('POST', 'photos', { upload, index: i, total, data: btoa(bin) });
  }
  return out.id;
}
function openChanges() {
  openSheet(`<div><h2 id="sheet-title">What's new</h2><p class="hint">The last ${changes.length === 1 ? 'update' : `${changes.length} updates`}.</p>
    ${changes.length ? changes.map(c => `<section class="change"><h3>Version ${esc(c.version)}</h3><p class="row-meta">${esc(fmt(c.date, { day: 'numeric', month: 'long', year: 'numeric' }))}</p><ul>${(c.items || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul></section>`).join('') : '<p class="empty">Nothing to show yet.</p>'}
    <div class="actions"><button type="button" class="btn" data-a="close">Close</button></div></div>`);
}
function openSwap(id) {
  const c = S.chores.get(id); if (!c) return;
  const now = effective(c), current = (c.people || []).length ? c.people.map(memberName).filter(Boolean).join(', ') : c.everyone ? 'Everyone' : memberName(now.assignee) || (c.anyLevel ? `anyone in ${levelNames(c.anyLevel) || 'that group'}` : 'Anyone');
  const main = (c.people || []).length ? c.people.map(memberName).filter(Boolean).join(', ') : c.anyLevel ? `anyone in ${levelNames(c.anyLevel) || 'that group'}` : c.level ? (levelNames(c.level) || 'the usual people') : c.everyone ? 'Everyone' : memberName(c.assignee) || 'Anyone';
  openSheet(`<form id="swap-form" data-id="${esc(id)}"><h2 id="sheet-title">Swap: ${esc(c.title)}</h2>
    <p class="hint">Due ${esc(fmtShort(now.due))}${now.time ? ` at ${esc(now.time)}` : ''}. Currently ${esc(current)}${current !== main ? `, usually ${esc(main)}` : ''}.</p>
    <div class="field"><label class="lab" for="sw-person">Move to</label><select id="sw-person" required><option value="" selected disabled>Choose a person</option>${members().filter(m => m.id !== now.assignee || c.everyone).map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div>
    <fieldset class="swap-kind"><legend>For how long?</legend>
      ${c.everyone ? '' : `<label class="inline-check"><input type="radio" name="sw-kind" value="once" checked> One time: goes back to ${esc(main)} afterwards</label>`}
      <label class="inline-check"><input type="radio" name="sw-kind" value="always" ${c.everyone ? 'checked' : ''}> Permanent: this person does it from now on${c.level || c.everyone ? `, instead of ${esc(main)}` : ''}</label></fieldset>
    <p class="form-error" id="sw-error" role="alert" hidden></p>
    <div class="actions">${c.once ? `<span class="left"><button type="button" class="btn" data-a="swap-reset" data-id="${esc(id)}">Undo the one-time swap</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Swap</button></div></form>`);
}
const levelNames = n => (levels[n] || []).map(memberName).filter(Boolean).join(', ');
function openLogin(id) {
  const m = S.members.get(id), l = logins[id]; if (!m) return;
  openSheet(`<form id="login-form" data-id="${esc(id)}"><h2 id="sheet-title">${l ? 'Change' : 'Give'} ${esc(m.name)}'s sign-in</h2>
    <div class="field"><label class="lab" for="lg-user">Email</label><input type="text" inputmode="email" id="lg-user" required autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" value="${esc(l ? l.username : '')}"></div>
    <div class="field"><label class="lab" for="lg-pass">${l ? 'New password' : 'Password'}</label><input type="text" id="lg-pass" ${l ? '' : 'required'} minlength="8" autocomplete="off" spellcheck="false"><div class="hint">${l ? 'Leave blank to keep the current password.' : 'At least 8 characters. Tell them what it is, and they can change it under Progress.'}</div></div>
    <div class="field"><label class="lab" for="lg-dob">Date of birth</label><input type="date" id="lg-dob" max="${localToday()}" value="${esc(l && l.dob || '')}"><div class="hint">On their birthday, their chores go to someone else in their group, so they have no jobs that day. Only admins can see this.</div></div>
    <fieldset class="roles"><legend>What they can do</legend>
      <label class="inline-check"><input type="checkbox" id="lg-cleaner" ${!l || l.cleaner ? 'checked' : ''}> Cleaner: clocks in to see and tick off chores</label>
      <fieldset class="level-pick"><legend>Cleaner groups</legend><div class="checks">${GROUPS.map(n => `<label class="check"><input type="checkbox" name="lg-group" value="${n}" ${(l ? l.groups || [] : [1]).includes(n) ? 'checked' : ''}> Group ${n}</label>`).join('')}</div></fieldset>
      <label class="inline-check"><input type="checkbox" id="lg-admin" ${l && l.admin ? 'checked' : ''}> Admin: sets chores, schedules and holidays, and manages people</label>
      <label class="inline-check"><input type="checkbox" id="lg-system" ${l && l.system ? 'checked' : ''} ${me.system ? '' : 'disabled'}> System user: installs updates${me.system ? '' : '. Only a system user can change this.'}</label></fieldset>
    <div class="field"><label class="lab" for="lg-tv">TiviSync profile</label><select id="lg-tv"><option value="">None</option>${l && l.tivisync ? `<option value="${esc(l.tivisync)}" selected>Loading…</option>` : ''}</select><div class="hint" id="lg-tv-hint">While they have chores to do, a reminder pops up on the TV where they're signed in to TiviSync.</div></div>
    <p class="form-error" id="lg-error" role="alert" hidden></p>
    <div class="actions">${l && id !== me.id ? `<span class="left"><button type="button" class="btn danger" data-a="login-del" data-id="${esc(id)}">Remove sign-in</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
  fillTivisync(l && l.tivisync || '');
}
async function fillTivisync(current) {
  const sel = document.getElementById('lg-tv'); if (!sel) return;
  try {
    const r = await call('GET', 'tivisync-profiles');
    if (r.error) document.getElementById('lg-tv-hint').textContent = r.error;
    sel.innerHTML = '<option value="">None</option>' + r.profiles.map(p => `<option value="${esc(p.id)}" ${p.id === current ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  } catch (e) { /* keep what is there */ }
}
function openPassword() {
  openSheet(`<form id="pw-form"><h2 id="sheet-title">Change password</h2>
    <div class="field"><label class="lab" for="pw-cur">Current password</label><input type="password" id="pw-cur" required autocomplete="current-password"></div>
    <div class="field"><label class="lab" for="pw-new">New password</label><input type="password" id="pw-new" required minlength="8" autocomplete="new-password"><div class="hint">At least 8 characters. Your other devices will be signed out.</div></div>
    <p class="form-error" id="pw-error" role="alert" hidden></p>
    <div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Change password</button></div></form>`);
}
const showFormError = (id, msg) => { const el = document.getElementById(id); el.textContent = msg; el.hidden = false; };
function openRoom(r) {
  openSheet(`<form id="room-form" data-id="${esc(r.id || '')}"><h2 id="sheet-title">${r.id ? 'Edit room' : 'Add a room'}</h2>
    <div class="field"><label class="lab" for="room-name">Room name</label><input type="text" id="room-name" required maxlength="60" value="${esc(r.name || '')}" autocomplete="off"></div>
    <div class="actions">${r.id ? `<span class="left"><button type="button" class="btn danger" data-a="room-del-ask" data-id="${esc(r.id)}">Delete</button></span>` : ''}<button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Save</button></div></form>`);
}
document.addEventListener('input', e => { if (e.target.closest('#chore-form')) syncChoreForm(); });
document.addEventListener('change', e => { if (e.target.id === 'f-assignee') syncChoreForm(); });
document.addEventListener('change', e => {
  if (['push-chat', 'push-chores', 'push-clock'].includes(e.target.id)) {
    const on = id => { const b = document.getElementById(id); return b ? b.checked : true; };
    const prefs = { chat: on('push-chat'), chores: on('push-chores'), clock: on('push-clock') };
    if (pushInfo) pushInfo.prefs = prefs;
    e.target.blur(); call('POST', 'push/prefs', prefs).catch(writeFailed); return;
  }
  if (e.target.dataset && e.target.dataset.quickgroup) {
    const id = e.target.dataset.id, groups = [...document.querySelectorAll(`[data-quickgroup][data-id="${CSS.escape(id)}"]:checked`)].map(b => +b.dataset.quickgroup);
    const hidden = (logins[id] && logins[id].groups || []).filter(n => !document.querySelector(`[data-quickgroup="${n}"][data-id="${CSS.escape(id)}"]`));
    e.target.blur();
    call('PUT', `members/${id}/groups`, { groups: [...new Set([...groups, ...hidden])] }).then(r => { if (logins[id]) logins[id].groups = r.groups; toast(`${memberName(id)}: ${groupLabel(r.groups)}`); scheduleRender(); }).catch(writeFailed);
    return;
  }
  if (e.target.dataset && e.target.dataset.nightgroup) { e.target.blur(); call('POST', 'night-groups', { groups: [...document.querySelectorAll('[data-nightgroup]:checked')].map(b => +b.dataset.nightgroup) }).catch(writeFailed); return; }
  if (e.target.id === 'of-hand') { document.getElementById('of-hand-hint').hidden = !e.target.checked; document.getElementById('of-weekly-wrap').hidden = e.target.checked; if (e.target.checked) { document.getElementById('of-weekly').checked = false; document.getElementById('of-to-wrap').hidden = false; } return; }
  if (e.target.id === 'of-weekly') { document.getElementById('of-to-wrap').hidden = e.target.checked; return; }
  if (e.target.name === 'dn-kind') { document.getElementById('dn-group-wrap').hidden = e.target.value !== 'home'; return; }
  if (e.target.dataset && e.target.dataset.shop) { e.target.blur(); call('POST', `shop/items/${encodeURIComponent(e.target.dataset.shop)}/tick`, { ordered: e.target.checked }).catch(writeFailed); return; }
  if (e.target.id === 'logs-who') { logsWho = e.target.value; report = null; e.target.blur(); scheduleRender(); return; }
  const id = e.target.dataset && e.target.dataset.member;
  if (id) { const name = e.target.value.trim(); const m = S.members.get(id); if (m && name && name !== m.name) call('PATCH', `members/${id}`, { name }).catch(writeFailed); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'chore-form') {
    const old = S.chores.get(f.dataset.id) || {};
    const v = id => document.getElementById(id)?.value;
    const unit = v('f-unit'), due = v('f-due');
    const c = { ...old, id: old.id || 'c' + uid(), title: v('f-title').trim(), kind: 'chore', roomId: v('f-room'), minutes: +v('f-minutes'),
      unit, every: Math.max(1, +v('f-every') || 1), due, basis: v('f-basis'), dom: toD(due).getUTCDate(), assignee: v('f-assignee') || '', rotate: !!document.getElementById('f-rotate')?.checked, notes: v('f-notes') || '', done: false, created: old.created || localToday() };
    if (due !== old.due) delete c.sched;
    const picked = [...f.querySelectorAll('input[name=f-person]:checked')].map(i => i.value);
    if (c.assignee === '__pick' && !picked.length) return toast('Tick at least one person.');
    if (c.assignee === '__pick') { c.people = picked; c.assignee = '__everyone'; } else delete c.people;
    const choreTime = v('f-time'); if (choreTime) c.time = choreTime; else delete c.time;
    const backupPick = v('f-backup');
    if (backupPick && backupPick === c.assignee) { return toast('Choose a different second person.'); }
    const groupPick = /^__group\d+$/.test(backupPick) ? +backupPick.slice(7) : 0;
    if (groupPick) c.backupGroup = groupPick; else delete c.backupGroup;
    if (backupPick && !groupPick) c.backup = backupPick; else delete c.backup;
    const anyPick = /^__any\d+$/.test(c.assignee) ? +c.assignee.slice(5) : 0;
    if (anyPick) { c.assignee = ''; c.anyLevel = anyPick; c.rotate = false; delete c.backup; delete c.backupGroup; delete c.once; if (!(levels[anyPick] || []).length) toast('Nobody is in that group yet, so only admins will see this chore.'); } else delete c.anyLevel;
    const levelPick = /^__level\d+$/.test(c.assignee) ? +c.assignee.slice(7) : 0;
    if (levelPick) {
      const ids = levels[levelPick] || [];
      if (!ids.length) { c.assignee = ''; }
      else c.assignee = old.level === levelPick && ids.includes(old.assignee) ? old.assignee : ids[0];
      c.level = levelPick; c.rotate = true;
    } else delete c.level;
    if (c.assignee === '__everyone') { c.assignee = ''; c.everyone = true; c.rotate = false; } else { delete c.everyone; delete c.doneBy; }
    if (levelPick && !(levels[levelPick] || []).length) toast('Nobody is in that group yet, so anyone can do this until someone is.');
    if (c.everyone) { delete c.backup; delete c.backupGroup; }
    closeSheet(); await put('chores', c); toast(old.id ? 'Saved.' : `${c.title} added.`);
  } else if (f.id === 'signin-form') {
    const go = document.getElementById('si-go'); go.disabled = true;
    try { await call('POST', 'login', { username: document.getElementById('si-user').value, password: document.getElementById('si-pass').value }); document.activeElement?.blur(); await refresh(); }
    catch (err) { showFormError('si-error', err.message); go.disabled = false; }
  } else if (f.id === 'login-form') {
    try { await call('PUT', `members/${f.dataset.id}/login`, { username: document.getElementById('lg-user').value, password: document.getElementById('lg-pass').value, cleaner: document.getElementById('lg-cleaner').checked, groups: [...document.querySelectorAll('[name=lg-group]:checked')].map(b => +b.value), dob: document.getElementById('lg-dob').value, admin: document.getElementById('lg-admin').checked, system: document.getElementById('lg-system').checked, tivisync: document.getElementById('lg-tv').value }); closeSheet(); toast('Sign-in saved.'); refresh(); }
    catch (err) { showFormError('lg-error', err.message); }
  } else if (f.id === 'pw-form') {
    try { await call('POST', 'password', { current: document.getElementById('pw-cur').value, next: document.getElementById('pw-new').value }); closeSheet(); toast('Password changed.'); }
    catch (err) { showFormError('pw-error', err.message); }
  } else if (f.id === 'shift-form') {
    try { await call('PATCH', `shifts/${encodeURIComponent(f.dataset.id)}`, { start: new Date(document.getElementById('sh-start').value).getTime(), end: document.getElementById('sh-end').value ? new Date(document.getElementById('sh-end').value).getTime() : null }); closeSheet(); toast('Session corrected.'); }
    catch (err) { showFormError('sh-error', err.message); }
  } else if (f.id === 'swap-form') {
    const c = S.chores.get(f.dataset.id), person = document.getElementById('sw-person').value, kind = f.querySelector('input[name=sw-kind]:checked').value;
    if (!c || !person) return;
    const next = { ...c };
    if (kind === 'once') next.once = { date: c.due, assignee: person };
    else { next.assignee = person; next.rotate = false; delete next.once; delete next.level; delete next.anyLevel; delete next.everyone; delete next.doneBy; delete next.people; if (next.backup === person) delete next.backup; }
    closeSheet(); await put('chores', next); toast(`${c.title} moved to ${memberName(person)}${kind === 'once' ? ' for one time' : ''}.`);
  } else if (f.id === 'proof-form') {
    const go = document.getElementById('pf-go'), file = document.getElementById('pf-photo').files[0];
    if (!file) return;
    go.disabled = true; go.textContent = 'Sending…';
    try { const photo = await uploadPhoto(file); closeSheet(); await complete(f.dataset.id, photo); }
    catch (err) { showFormError('pf-error', err.message); go.disabled = false; go.textContent = 'Send and tick off'; }
  } else if (f.id === 'review-form') {
    const go = document.getElementById('rv-go'), note = document.getElementById('rv-note').value.trim(), file = document.getElementById('rv-photo').files[0];
    if (!note && !file) return showFormError('rv-error', 'Add a note or a photo so they know what to fix.');
    go.disabled = true; go.textContent = 'Sending…';
    try {
      const photo = file ? await uploadPhoto(file) : '';
      await call('POST', `reviews/${encodeURIComponent(f.dataset.id)}/reject`, { note, photo });
      closeSheet(); toast('Sent back again, and posted in Chat.'); refresh();
    } catch (err) { showFormError('rv-error', err.message); go.disabled = false; go.textContent = 'Send back again'; }
  } else if (f.id === 'trip-form') {
    const doc = { name: document.getElementById('tr-name').value, from: document.getElementById('tr-from').value, to: document.getElementById('tr-to').value };
    if (doc.from > doc.to) return showFormError('tr-error', "The last day can't be before the first day.");
    try { await call('PUT', `d/trips/${encodeURIComponent(f.dataset.id || 't' + uid())}`, doc); closeSheet(); toast('Family holiday saved.'); }
    catch (err) { showFormError('tr-error', err.message); }
  } else if (f.id === 'event-form') {
    const doc = { title: document.getElementById('ev-title').value, date: document.getElementById('ev-date').value, time: document.getElementById('ev-time').value, unit: document.getElementById('ev-unit').value, every: 1, notes: document.getElementById('ev-notes').value, people: [...f.querySelectorAll('input[name=ev-person]:checked')].map(i => i.value) };
    try { await call('PUT', `d/events/${encodeURIComponent(f.dataset.id || 'e' + uid())}`, doc); closeSheet(); toast('Reminder saved.'); }
    catch (err) { showFormError('ev-error', err.message); }
  } else if (f.id === 'out-form') {
    const v2 = id => document.getElementById(id).value;
    const doc = { memberId: document.getElementById('of-who')?.value, activity: v2('of-what'), from: v2('of-from'), to: v2('of-to'), start: v2('of-start'), end: v2('of-end'), weekly: document.getElementById('of-weekly').checked };
    const hand = !!document.getElementById('of-hand')?.checked;
    try {
      if (hand) {
        if (!doc.activity.trim()) return showFormError('of-error', 'Type what the activity is.');
        if (!!doc.start !== !!doc.end) return showFormError('of-error', 'Enter both times, or leave both blank for all day.');
        const to = doc.to || doc.from;
        if (to < doc.from) return showFormError('of-error', "The last day can't be before the first day.");
        await call('PUT', `d/away/${encodeURIComponent(f.dataset.away || 'a' + uid())}`, { reason: doc.activity, memberId: doc.memberId, from: doc.from, to, coverId: '', allDay: !doc.start, ...(doc.start ? { leave: doc.start, back: doc.end } : {}) });
        if (f.dataset.id) await call('DELETE', `outings/${encodeURIComponent(f.dataset.id)}`);
      } else {
        await (f.dataset.id ? call('PUT', `outings/${encodeURIComponent(f.dataset.id)}`, doc) : call('POST', 'outings', doc));
        if (f.dataset.away) await call('DELETE', `d/away/${encodeURIComponent(f.dataset.away)}`);
      }
      closeSheet(); toast('Activity saved.');
    }
    catch (err) { showFormError('of-error', err.message); }
  } else if (f.id === 'ar-form') {
    const box = document.getElementById('ar-new');
    try { await call('POST', 'away-reasons', { name: box.value }); box.value = ''; box.blur(); scheduleRender(); }
    catch (err) { toast(err.message); }
  } else if (f.id === 'extra-form') {
    const doc = { extra: true, title: document.getElementById('xj-text').value, roomId: document.getElementById('xj-room').value, minutes: +document.getElementById('xj-mins').value, by: me.id, date: localToday() };
    try { await call('PUT', `d/log/${encodeURIComponent('l' + uid())}`, doc); closeSheet(); toast('Added. An admin has been told.'); }
    catch (err) { showFormError('xj-error', err.message); }
  } else if (f.id === 'sick-form') {
    const who = document.getElementById('sk-who').value;
    try { await call('POST', `sick/${encodeURIComponent(who)}`); closeSheet(); toast('Chores paused for 12 hours.'); }
    catch (err) { showFormError('sk-error', err.message); }
  } else if (f.id === 'night-form') {
    const doc = { typeId: document.querySelector('[name=nf-type]:checked')?.value, date: document.getElementById('nf-date').value, time: document.getElementById('nf-time').value };
    try { await (f.dataset.id ? call('PUT', `nights/${encodeURIComponent(f.dataset.id)}`, doc) : call('POST', 'nights', doc)); closeSheet(); toast('Night saved.'); }
    catch (err) { showFormError('nf-error', err.message); }
  } else if (f.id === 'nt-form') {
    const box = document.getElementById('nt-name');
    try { await call('POST', 'night-types', { name: box.value, icon: document.getElementById('nt-icon').value }); box.value = ''; box.blur(); scheduleRender(); }
    catch (err) { toast(err.message); }
  } else if (f.id === 'dtask-form') {
    const doc = { dinner: f.dataset.dinner, text: document.getElementById('dt-text').value, date: document.getElementById('dt-date').value, group: +document.getElementById('dt-group').value };
    try { await call('PUT', `d/dinnerTasks/${encodeURIComponent(f.dataset.id || 'dt' + uid())}`, doc); closeSheet(); toast('Reminder saved.'); }
    catch (err) { showFormError('dt-error', err.message); }
  } else if (f.id === 'dinner-form') {
    const date = f.dataset.id || document.getElementById('dn-date').value;
    const doc = { kind: document.querySelector('[name=dn-kind]:checked').value, group: +document.getElementById('dn-group').value, meal: document.getElementById('dn-meal').value.trim() };
    if (!dinnerPlanned(doc)) return showFormError('dn-error', 'Choose a group or type what you are having.');
    if (!f.dataset.id && dinnerPlanned(S.dinners.get(date))) return showFormError('dn-error', 'That day already has a dinner. Edit it from the list instead.');
    try { await call('PUT', `d/dinners/${encodeURIComponent(date)}`, doc); closeSheet(); toast('Dinner saved.'); }
    catch (err) { showFormError('dn-error', err.message); }
  } else if (f.id === 'delay-form') {
    const reason = document.getElementById('dl-why').value.trim();
    if (!reason) { toast('Say why you are delaying it.'); return; }
    const id = f.dataset.id; closeSheet(); later(id, reason);
  } else if (f.id === 'shop-form') {
    const text = document.getElementById('shop-text').value.trim();
    if (!text) return;
    const why = shopWarning(text);
    if (why) {
      shopPending = text;
      openSheet(`<form id="shop-confirm"><h2 id="sheet-title">Are you sure?</h2><p>${esc(why)}</p><div class="actions"><button type="button" class="btn" data-a="close">Cancel</button><button class="btn primary">Add anyway</button></div></form>`);
      return;
    }
    shopAdd(text);
  } else if (f.id === 'shop-confirm') {
    closeSheet(); shopAdd(shopPending);
  } else if (f.id === 'chat-form') {
    const box = document.getElementById('chat-text'), text = box.value.trim();
    if (!text) return;
    try {
      await call('POST', 'chat', { text });
      chatDraft = ''; const now = document.getElementById('chat-text'); if (now) { now.value = ''; now.focus(); }
      setTimeout(scrollChat, 100);
    } catch (err) { toast(err.message); }
  } else if (f.id === 'back-chore-form') {
    const go = document.getElementById('bc-go'), note = document.getElementById('bc-note').value.trim(), file = document.getElementById('bc-photo').files[0];
    if (!note && !file) return showFormError('bc-error', 'Add a note or a photo so they know what to fix.');
    go.disabled = true; go.textContent = 'Sending…';
    try {
      const photo = file ? await uploadPhoto(file) : '';
      await call('POST', `log/${encodeURIComponent(f.dataset.id)}/return`, { note, photo, needPhoto: document.getElementById('bc-need').checked });
      closeSheet(); logsData = null; toast('Sent back, and posted in Chat.'); refresh();
    } catch (err) { showFormError('bc-error', err.message); go.disabled = false; go.textContent = 'Send back'; }
  } else if (f.id === 'work-form') {
    const start = document.getElementById('wk-start').value, end = document.getElementById('wk-end').value;
    if (start === end) return showFormError('wk-error', "The start and finish can't be the same time.");
    const doc = { memberId: document.getElementById('wk-person').value, date: document.getElementById('wk-date').value, start, end, note: document.getElementById('wk-note').value };
    try { await call('PUT', `d/work/${encodeURIComponent(f.dataset.id || 'w' + uid())}`, doc); closeSheet(); toast('Shift saved.'); }
    catch (err) { showFormError('wk-error', err.message); }
  } else if (f.id === 'sched-form') {
    const days = {};
    for (let d = 1; d <= 7; d++) if (document.getElementById(`sc-on-${d}`).checked) {
      const start = document.getElementById(`sc-start-${d}`).value, end = document.getElementById(`sc-end-${d}`).value;
      if (!start || !end || start >= end) return showFormError('sc-error', `${DAY_NAMES[d - 1]}'s finish time needs to be after its start time.`);
      days[d] = { start, end };
    }
    const doc = { id: f.dataset.id, place: document.getElementById('sc-place').value.trim() || 'School', days };
    closeSheet(); await put('schedules', doc); toast('Times saved.');
  } else if (f.id === 'hol-form') {
    const from = document.getElementById('hl-from').value, to = document.getElementById('hl-to').value;
    if (from > to) return showFormError('hl-error', "The last day can't be before the first day.");
    const people = [...f.querySelectorAll('input[name=hol-person]:checked')].map(i => i.value);
    const doc = { id: f.dataset.id || 'h' + uid(), name: document.getElementById('hl-name').value.trim(), from, to, people };
    closeSheet(); await put('holidays', doc); toast('Holiday saved.');
  } else if (f.id === 'up-form') {
    const go = document.getElementById('up-go'), file = document.getElementById('up-file').files[0];
    if (!file) return;
    go.disabled = true; go.textContent = 'Checking…';
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()), size = 40 * 1024, total = Math.max(1, Math.ceil(bytes.length / size)), id = 'u' + uid();
      let info = null;
      for (let i = 0; i < total; i++) {
        let bin = ''; for (const b of bytes.subarray(i * size, (i + 1) * size)) bin += String.fromCharCode(b);
        info = await call('POST', 'system/upload', { id, index: i, total, data: btoa(bin) });
      }
      openSheet(`<form id="inst-form"><h2 id="sheet-title">Install version ${esc(info.version)}?</h2>
        <p>This replaces version ${esc(info.current)}. Your files and data are backed up first, and the previous version comes back automatically if the new one doesn't start.</p>
        ${info.notes ? `<p class="hint" style="white-space:pre-wrap">${esc(info.notes)}</p>` : ''}
        <div class="field"><label class="lab" for="in-pass">Your password</label><input type="password" id="in-pass" required autocomplete="current-password"></div>
        <p class="form-error" id="in-error" role="alert" hidden></p>
        <div class="actions"><button type="button" class="btn" data-a="sys-cancel">Cancel</button><button class="btn primary">Install</button></div></form>`);
    } catch (err) { showFormError('up-error', err.message); go.disabled = false; go.textContent = 'Check package'; }
  } else if (f.id === 'inst-form' || f.id === 'back-form') {
    const install = f.id === 'inst-form';
    try {
      const r = await call('POST', install ? 'system/install' : 'system/rollback', { password: document.getElementById(install ? 'in-pass' : 'bk-pass').value });
      waitForUpdate(r.id);
    } catch (err) { showFormError(install ? 'in-error' : 'bk-error', err.message); }
  } else if (f.id === 'room-form') {
    const name = document.getElementById('room-name').value.trim(); const old = S.rooms.get(f.dataset.id);
    closeSheet(); await put('rooms', old ? { ...old, name } : { id: 'r' + uid(), name, order: S.rooms.size + 1 });
  } else if (f.id === 'member-form') {
    const inp = document.getElementById('member-new'), name = inp.value.trim(); if (!name) return;
    inp.value = ''; inp.blur(); try { await call('POST', 'members', { name }); } catch (err) { writeFailed(err); }
  } else if (f.id === 'setup-form') {
    const go = document.getElementById('setup-go');
    const picked = [...f.querySelectorAll('input[name=room]:checked')].map(i => i.value);
    const pets = document.getElementById('setup-pets').checked, kids = document.getElementById('setup-kids').checked;
    const namesEl = document.getElementById('setup-names');
    const names = namesEl ? namesEl.value.split(',').map(s => s.trim()).filter(Boolean) : [];
    go.disabled = true; go.textContent = 'Building…';
    const people = [];
    if (me.admin) for (const name of names) { try { people.push((await call('POST', 'members', { name })).id); } catch (err) { writeFailed(err); } }
    if (people.length) people.unshift(me.id);
    const built = buildHome({ rooms: picked, pets, kids, people }, localToday());
    const existing = new Map(rooms().map(r => [r.name, r.id]));
    const have = new Set([...allChores().map(c => c.title), ...[...S.events.values()].map(e => e.title)]);
    const idMap = new Map();
    const newRooms = [];
    built.rooms.forEach((r, i) => { if (existing.has(r.name)) idMap.set(r.id, existing.get(r.name)); else { idMap.set(r.id, r.id); newRooms.push({ ...r, order: S.rooms.size + i }); } });
    const newChores = built.chores.filter(c => !have.has(c.title)).map(c => ({ ...c, roomId: idMap.get(c.roomId) }));
    if (sheet.open) closeSheet();
    for (const r of newRooms) await put('rooms', r);
    let added = 0;
    for (const c of newChores) {
      if (c.kind === 'reminder') { try { await call('PUT', `d/events/e${uid()}`, { title: c.title, date: c.due, unit: c.unit, every: c.every, people: [] }); } catch (err) { writeFailed(err); } }
      else { await put('chores', c); added++; }
    }
    toast(`${added} chores added.`);
  }
});
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#backup-link')) { toast('Your backup is downloading.'); setTimeout(() => { sys = null; scheduleRender(); }, 3000); } });
window.addEventListener('hashchange', () => { sys = null; logsData = null; report = null; stats = null; scheduleRender(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && me) refresh(); });
sheet.addEventListener('close', () => { sheet.innerHTML = ''; });
refresh();
setInterval(() => { if (me && !document.hidden) { scheduleRender(); queueReminders(); } }, 60000);

/* An eye on every password box, to show or hide what's typed. */
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/></svg>';
function addPasswordEyes() {
  for (const box of document.querySelectorAll('input[type=password]:not([data-eye])')) {
    box.dataset.eye = '1';
    const wrap = document.createElement('span'); wrap.className = 'pw-wrap';
    box.parentNode.insertBefore(wrap, box); wrap.appendChild(box);
    const eye = document.createElement('button');
    eye.type = 'button'; eye.className = 'pw-eye'; eye.innerHTML = EYE; eye.setAttribute('aria-label', 'Show password');
    eye.addEventListener('mousedown', e => e.preventDefault());
    eye.addEventListener('click', () => {
      const show = box.type === 'password';
      box.type = show ? 'text' : 'password';
      eye.innerHTML = show ? EYE_OFF : EYE;
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    wrap.appendChild(eye);
  }
}
new MutationObserver(addPasswordEyes).observe(document.body, { childList: true, subtree: true });
addPasswordEyes();

/* Offers the app in the browser. Android and computers only offer it if it isn't installed; iPhones can't tell us, so they get the steps. */
let installEvent = null;
const isInstalledApp = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
function installHTML() {
  if (isInstalledApp()) return '';
  const body = installEvent ? '<p class="hint">Add Family Planner to this device, with its own icon.</p><div class="pills"><button class="btn primary" data-a="app-install">Install</button></div>'
    : isIphone() ? '<p class="hint">If you do not have it yet, open this page in Safari, tap Share, then Add to Home Screen.</p>'
    : '<p class="hint">If you do not have it yet, open your browser menu and choose Install app or Add to Home screen.</p>';
  return `<h2 class="sec" style="margin-top:28px">Install the app</h2>${body}`;
}
function showInstall() { document.querySelectorAll('.install-slot').forEach(el => { el.innerHTML = installHTML(); }); }
async function installApp() {
  if (!installEvent) return;
  const ev = installEvent;
  installEvent = null; showInstall();
  ev.prompt();
  await ev.userChoice.catch(() => {});
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; showInstall(); });
window.addEventListener('appinstalled', () => { installEvent = null; showInstall(); });
