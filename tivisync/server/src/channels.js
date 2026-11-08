'use strict';
// Channel manager: loads a source's live channel list on the server, groups the same channel in
// different qualities ("BBC One SD / HD / FHD" -> "BBC One"), and works out per-profile visibility.
//
// A channel is identified by its "ref": the Xtream stream_id, or the stream URL for M3U playlists
// (stable across playlist edits, unlike a position number). The TV app computes the same ref.

const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------------ names & quality

// quality markers, best first. rank decides ordering in the quality picker.
const QUALITY = [
  { re: /\b(8k)\b/i, label: '8K', rank: 6 },
  { re: /\b(4k|uhd|2160p?)\b|ᵁᴴᴰ/i, label: '4K', rank: 5 },
  { re: /\b(fhd|1080[pi]?|full ?hd)\b|ᶠᴴᴰ/i, label: 'FHD', rank: 4 },
  { re: /\b(hd|720p?)\b|ᴴᴰ/i, label: 'HD', rank: 3 },
  { re: /\b(sd|576[pi]?|480p?)\b|ˢᴰ/i, label: 'SD', rank: 1 },
];
const EXTRA_TAGS = /\b(hevc|h\.?265|h\.?264|50 ?fps|60 ?fps|raw|backup|alt|vip|multi)\b/gi;
const PREFIX = /^\s*(?:(?:\|[^|]{1,12}\|)|(?:\[[^\]]{1,12}\])|(?:[A-Z]{2,3}|VIP|4K)\s*[|:\-–]{1,2})\s*/;

function quality(name) {
  for (const q of QUALITY) if (q.re.test(name)) return q;
  return null;
}

/** "UK: BBC One FHD ᴴᴰ" -> "bbc one" (grouping key); "+1" channels stay separate. */
function baseName(name) {
  let s = String(name || '');
  for (let i = 0; i < 3; i++) s = s.replace(PREFIX, '');
  s = s.replace(/[ᴬ-ᵡ]+/g, ' ');
  for (const q of QUALITY) s = s.replace(new RegExp(q.re.source, 'gi'), ' ');
  s = s.replace(EXTRA_TAGS, ' ').replace(/\+\s*1\b/g, ' plus1 ').replace(/\+\s*24\b/g, ' plus24 ');
  // spaces ignored so "ITV 1" and "ITV1" match
  return s.toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Display name for a group: the cleanest member name without quality tags. */
function displayName(name) {
  let s = String(name || '');
  for (let i = 0; i < 3; i++) s = s.replace(PREFIX, '');
  s = s.replace(/[ᴬ-ᵡ]+/g, ' ');
  for (const q of QUALITY) s = s.replace(new RegExp(q.re.source, 'gi'), ' ');
  s = s.replace(EXTRA_TAGS, ' ').replace(/[\s\-|:]+$/g, '').replace(/^\s*[\-|:]+/, '').replace(/\s{2,}/g, ' ').trim();
  return s || String(name || '').trim();
}

function labelFor(name, others) {
  const q = quality(name);
  const extra = [];
  if (/\b(hevc|h\.?265)\b/i.test(name)) extra.push('HEVC');
  if (/\b(50|60) ?fps\b/i.test(name)) extra.push(name.match(/\b(50|60) ?fps\b/i)[1] + 'fps');
  const base = q ? q.label : 'Standard';
  return { label: [base, ...extra].join(' '), rank: q ? q.rank : 2 };
}

// ------------------------------------------------------------------ loading channel lists

const cache = new Map(); // sourceId -> { at, categories, channels, error }
const TTL = 6 * 3600_000;

async function fetchText(url, ms = 60_000) {
  const r = await fetch(url, { headers: { 'User-Agent': 'TiviSync/1.0' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`provider answered ${r.status}`);
  return r.text();
}

function allUrls(src) {
  let backups = [];
  try { backups = src.backup_urls ? JSON.parse(src.backup_urls) : []; } catch { /* ignore */ }
  return [src.url, ...backups].filter(Boolean).map((u) => String(u).replace(/\/+$/, ''));
}

async function loadXtream(src) {
  const u = encodeURIComponent(src.username || ''), p = encodeURIComponent(src.password || '');
  let lastErr;
  for (const base of allUrls(src)) {
    try {
      const api = (a) => `${base}/player_api.php?username=${u}&password=${p}&action=${a}`;
      const cats = JSON.parse(await fetchText(api('get_live_categories')));
      const streams = JSON.parse(await fetchText(api('get_live_streams'), 120_000));
      if (!Array.isArray(streams)) throw new Error('provider did not return a channel list');
      return {
        categories: (Array.isArray(cats) ? cats : []).map((c) => ({ id: String(c.category_id), name: String(c.category_name || '') })),
        channels: streams.map((s, i) => ({ ref: String(s.stream_id), name: String(s.name || ''), logo: s.stream_icon || null,
          categoryId: String(s.category_id ?? ''), num: Number(s.num) || i + 1 })),
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no server address');
}

function parseM3u(text) {
  // mirrors the TV app's parser: same live / film / series split, same names
  const attr = /([\w-]+)="([^"]*)"/g;
  const seRe = /^(.*?)[\s._-]*[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/;
  const vodExt = new Set(['mp4', 'mkv', 'avi', 'mov', 'm4v', 'wmv']);
  const channels = []; const cats = new Map();
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#EXTINF/i.test(line)) {
      const a = {}; let m; attr.lastIndex = 0;
      while ((m = attr.exec(line))) a[m[1].toLowerCase()] = m[2];
      const comma = line.lastIndexOf(',');
      pending = { name: (comma >= 0 ? line.slice(comma + 1).trim() : '') || a['tvg-name'] || 'Channel',
        group: a['group-title'] || 'Uncategorised', logo: a['tvg-logo'] || null };
    } else if (line && !line.startsWith('#') && pending) {
      const ext = line.split('?')[0].split('.').pop().toLowerCase();
      const isSeries = line.includes('/series/') || (vodExt.has(ext) && seRe.test(pending.name));
      const isMovie = !isSeries && (line.includes('/movie/') || vodExt.has(ext));
      if (!isSeries && !isMovie) {
        if (!cats.has(pending.group)) cats.set(pending.group, { id: pending.group, name: pending.group });
        channels.push({ ref: line, name: pending.name, logo: pending.logo, categoryId: pending.group, num: channels.length + 1 });
      }
      pending = null;
    }
  }
  return { categories: [...cats.values()], channels };
}

async function loadM3u(src, filesDir, hosted) {
  if (src.url && src.url.startsWith(hosted)) {
    const f = path.join(filesDir, src.url.slice(hosted.length));
    if (!fs.existsSync(f)) throw new Error('no playlist file uploaded yet');
    return parseM3u(fs.readFileSync(f, 'utf8'));
  }
  let lastErr;
  for (const u of allUrls(src)) {
    try { return parseM3u(await fetchText(u, 120_000)); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no playlist address');
}

async function channelsFor(src, { force = false, filesDir, hosted } = {}) {
  const c = cache.get(src.id);
  if (!force && c && Date.now() - c.at < TTL && c.channels.length) return c;
  try {
    const r = src.type === 'xtream' ? await loadXtream(src) : await loadM3u(src, filesDir, hosted);
    const entry = { at: Date.now(), ...r, error: null };
    cache.set(src.id, entry);
    return entry;
  } catch (e) {
    if (c) { c.error = e.message; return c; }
    return { at: 0, categories: [], channels: [], error: e.message };
  }
}

// ------------------------------------------------------------------ grouping

/**
 * cfg (per source, stored as JSON): { split: [groupKey], merges: { ref: groupKey }, names: { key: name }, defaults: { key: ref } }
 * Returns groups (every channel is in exactly one group; most groups have one member).
 */
function buildGroups(channels, cfg = {}) {
  const split = new Set(cfg.split || []);
  const merges = cfg.merges || {};
  const groups = new Map();
  for (const ch of channels) {
    let key = merges[ch.ref] || 'n:' + baseName(ch.name);
    if (key === 'n:') key = 'r:' + ch.ref;
    if (split.has(key) && !merges[ch.ref]) key = 'r:' + ch.ref;
    let g = groups.get(key);
    if (!g) { g = { key, members: [] }; groups.set(key, g); }
    g.members.push(ch);
  }
  const out = [];
  for (const g of groups.values()) {
    const members = g.members.map((m) => ({ ...m, ...labelFor(m.name) }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)); // SD at the top … FHD / 4K at the bottom
    // same label twice (e.g. two "HD" feeds): number them so they can be told apart
    const seen = {};
    for (const m of members) { seen[m.label] = (seen[m.label] || 0) + 1; if (seen[m.label] > 1) m.label += ` (${seen[m.label]})`; }
    const pick = cfg.defaults?.[g.key];
    const def = members.find((m) => m.ref === pick) || members.find((m) => m.rank === 4) || members.find((m) => m.rank === 3) || members[members.length - 1];
    out.push({
      key: g.key,
      name: cfg.names?.[g.key] || (members.length > 1 ? displayName(def.name) : def.name),
      auto: !Object.values(merges).includes(g.key),
      categoryIds: [...new Set(members.map((m) => m.categoryId))],
      logo: members.find((m) => m.logo)?.logo || null,
      num: Math.min(...members.map((m) => m.num || 1e9)),
      default: def.ref,
      members: members.map(({ ref, name, label, rank, categoryId }) => ({ ref, name, label, rank, categoryId })),
    });
  }
  return out.sort((a, b) => a.num - b.num);
}

module.exports = { channelsFor, buildGroups, baseName, displayName, labelFor, parseM3u, cache };
