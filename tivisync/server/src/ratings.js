'use strict';
// Age ratings for films and series. The server loads each source's film/series library, looks the titles up
// on TMDB in the background (UK BBFC certificate first, US as a fallback) and stores an age per title.
// Profiles with an age limit only see titles rated at or below it; unrated titles are hidden for them.
//
// Title refs match what the TV app uses: Xtream stream_id / series_id; for M3U the film's URL and the
// series id "<group>|<show name>".

const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------------ certificates -> ages

const AGE_LABEL = (age) => (age == null ? null : age <= 0 ? 'U' : age <= 8 ? 'PG' : age <= 12 ? '12' : age <= 15 ? '15' : '18');

function certToAge(cert, country) {
  const c = String(cert || '').trim().toUpperCase();
  if (!c) return null;
  if (country === 'GB') {
    if (c === 'U' || c === 'UC') return 0;
    if (c === 'PG') return 8;
    if (c === '12' || c === '12A') return 12;
    if (c === '15') return 15;
    if (c === '18' || c === 'R18') return 18;
  }
  if (country === 'US') {
    const map = { G: 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, PG: 8, 'TV-PG': 8, 'PG-13': 12, 'TV-14': 15, R: 15, 'NC-17': 18, 'TV-MA': 18 };
    if (c in map) return map[c];
  }
  // many other countries use plain ages ("12", "16", "FSK 16", "+13")
  const n = c.match(/(\d{1,2})/);
  if (n) { const v = Number(n[1]); if (v >= 0 && v <= 21) return v >= 18 ? 18 : v; }
  if (/^(ALL|TP|AL|U|G|L|A)$/.test(c)) return 0;
  return null;
}

// ------------------------------------------------------------------ title clean-up

const PREFIX = /^\s*(?:(?:\|[^|]{1,12}\|)|(?:\[[^\]]{1,12}\])|(?:[A-Z]{2,3}|VOD|4K|NF|AMZ|DSNP|MULTI)\s*[|:\-–]{1,2})\s*/;
const TAGS = /\b(4k|uhd|2160p|1080p|720p|fhd|hd|sd|hevc|h265|x265|h264|multi ?sub|multi|dubbed|subbed|vostfr|remastered|extended|imax|director'?s cut)\b/gi;

function cleanTitle(raw) {
  let s = String(raw || '');
  for (let i = 0; i < 3; i++) s = s.replace(PREFIX, '');
  let year = null;
  const y = s.match(/[(\[]\s*((?:19|20)\d{2})\s*[)\]]/) || s.match(/(?:\s|-)((?:19[3-9]|20[0-4])\d)\s*$/);
  if (y) { year = Number(y[1]); s = s.replace(y[0], ' '); }
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(TAGS, ' ').replace(/[\s\-–|:]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  return { title: s, year };
}
const norm = (t) => String(t || '').toLowerCase().replace(/&/g, 'and').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/^the /, '');

// ------------------------------------------------------------------ library loading

const libCache = new Map(); // sourceId -> { at, movies: [{ref,name,year,tmdb}], series: [...] }

async function fetchJson(url, ms = 120_000) {
  const r = await fetch(url, { headers: { 'User-Agent': 'TiviSync/1.0' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`provider answered ${r.status}`);
  return r.json();
}

function allUrls(src) {
  let backups = [];
  try { backups = src.backup_urls ? JSON.parse(src.backup_urls) : []; } catch { /* ignore */ }
  return [src.url, ...backups].filter(Boolean).map((u) => String(u).replace(/\/+$/, ''));
}

const tmdbOf = (o) => { const v = Number(o.tmdb || o.tmdb_id || 0); return v > 0 ? v : null; };
const yearOf = (o) => { const v = String(o.year || o.releaseDate || o.release_date || o.releasedate || '').match(/(19|20)\d{2}/); return v ? Number(v[0]) : null; };

async function loadXtreamLibrary(src) {
  const u = encodeURIComponent(src.username || ''), p = encodeURIComponent(src.password || '');
  let lastErr;
  for (const base of allUrls(src)) {
    try {
      const api = (a) => `${base}/player_api.php?username=${u}&password=${p}&action=${a}`;
      const vods = await fetchJson(api('get_vod_streams'));
      const series = await fetchJson(api('get_series'));
      return {
        movies: (Array.isArray(vods) ? vods : []).map((o) => ({ ref: String(o.stream_id), name: String(o.name || ''), year: yearOf(o), tmdb: tmdbOf(o), adult: o.is_adult == 1 })),
        series: (Array.isArray(series) ? series : []).map((o) => ({ ref: String(o.series_id), name: String(o.name || ''), year: yearOf(o), tmdb: tmdbOf(o), adult: false })),
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no server address');
}

function parseM3uLibrary(text) {
  // mirrors the TV app's M3U parser so refs match
  const attr = /([\w-]+)="([^"]*)"/g;
  const seRe = /^(.*?)[\s._-]*[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/;
  const vodExt = new Set(['mp4', 'mkv', 'avi', 'mov', 'm4v', 'wmv']);
  const movies = []; const series = new Map();
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#EXTINF/i.test(line)) {
      const a = {}; let m; attr.lastIndex = 0;
      while ((m = attr.exec(line))) a[m[1].toLowerCase()] = m[2];
      const comma = line.lastIndexOf(',');
      pending = { name: (comma >= 0 ? line.slice(comma + 1).trim() : '') || a['tvg-name'] || 'Channel', group: a['group-title'] || 'Uncategorised' };
    } else if (line && !line.startsWith('#') && pending) {
      const ext = line.split('?')[0].split('.').pop().toLowerCase();
      const isSeries = line.includes('/series/') || (vodExt.has(ext) && seRe.test(pending.name));
      const isMovie = !isSeries && (line.includes('/movie/') || vodExt.has(ext));
      if (isSeries) {
        const m = pending.name.match(seRe);
        const show = (m && m[1].trim()) || pending.name;
        const id = `${pending.group}|${show}`;
        if (!series.has(id)) series.set(id, { ref: id, name: show, year: null, tmdb: null, adult: false });
      } else if (isMovie) movies.push({ ref: line, name: pending.name, year: null, tmdb: null, adult: false });
      pending = null;
    }
  }
  return { movies, series: [...series.values()] };
}

async function libraryFor(src, { force = false, filesDir, hosted } = {}) {
  const c = libCache.get(src.id);
  if (!force && c && Date.now() - c.at < 6 * 3600_000) return c;
  let lib;
  if (src.type === 'xtream') lib = await loadXtreamLibrary(src);
  else if (src.url && src.url.startsWith(hosted)) {
    const f = path.join(filesDir, src.url.slice(hosted.length));
    lib = fs.existsSync(f) ? parseM3uLibrary(fs.readFileSync(f, 'utf8')) : { movies: [], series: [] };
  } else {
    let text = null, lastErr;
    for (const u of allUrls(src)) {
      try { const r = await fetch(u, { signal: AbortSignal.timeout(120_000) }); if (!r.ok) throw new Error(`playlist ${r.status}`); text = await r.text(); break; } catch (e) { lastErr = e; }
    }
    if (text == null) throw lastErr || new Error('no playlist');
    lib = parseM3uLibrary(text);
  }
  const entry = { at: Date.now(), ...lib };
  libCache.set(src.id, entry);
  return entry;
}

// ------------------------------------------------------------------ TMDB lookup

/** Returns { tmdbId, cert, country, age } or null when nothing reliable was found. */
async function lookup(tmdb, kind, item) {
  const { title, year } = cleanTitle(item.name);
  const y = item.year || year;
  let id = item.tmdb;
  if (!id) {
    if (!title) return null;
    const search = kind === 'movie'
      ? await tmdb('/search/movie', { query: title, include_adult: 'true', ...(y ? { year: y } : {}) })
      : await tmdb('/search/tv', { query: title, include_adult: 'true', ...(y ? { first_air_date_year: y } : {}) });
    let results = search.results || [];
    if (!results.length && y) { // year can be off by one (release vs premiere)
      const again = kind === 'movie' ? await tmdb('/search/movie', { query: title, include_adult: 'true' }) : await tmdb('/search/tv', { query: title, include_adult: 'true' });
      results = (again.results || []).filter((r) => { const ry = Number(String(r.release_date || r.first_air_date || '').slice(0, 4)); return !ry || Math.abs(ry - y) <= 1; });
    }
    const want = norm(title);
    const exact = results.find((r) => norm(r.title || r.name) === want || norm(r.original_title || r.original_name) === want);
    const pick = exact || (results.length === 1 ? results[0] : null);
    if (!pick) return null;
    if (pick.adult) return { tmdbId: pick.id, cert: '18', country: 'adult', age: 18 };
    id = pick.id;
  }
  if (kind === 'movie') {
    const d = await tmdb(`/movie/${id}`, { append_to_response: 'release_dates' });
    if (d.adult) return { tmdbId: id, cert: '18', country: 'adult', age: 18 };
    const rel = d.release_dates?.results || [];
    for (const country of ['GB', 'US', 'IE', 'AU', 'DE']) {
      const r = rel.find((x) => x.iso_3166_1 === country);
      const cert = (r?.release_dates || []).map((x) => x.certification).find((c) => c && c.trim());
      const age = certToAge(cert, country);
      if (age != null) return { tmdbId: id, cert, country, age };
    }
    return { tmdbId: id, cert: null, country: null, age: null };
  }
  const d = await tmdb(`/tv/${id}`, { append_to_response: 'content_ratings' });
  if (d.adult) return { tmdbId: id, cert: '18', country: 'adult', age: 18 };
  const cr = d.content_ratings?.results || [];
  for (const country of ['GB', 'US', 'IE', 'AU', 'DE']) {
    const cert = cr.find((x) => x.iso_3166_1 === country)?.rating;
    const age = certToAge(cert, country);
    if (age != null) return { tmdbId: id, cert, country, age };
  }
  return { tmdbId: id, cert: null, country: null, age: null };
}

// ------------------------------------------------------------------ adult channels (for limited profiles)

const ADULT = /(\bxxx\b|\badult|18\s*\+|\+\s*18|\bporn|\bplayboy|\bpenthouse|\bhustler|\bbrazzers|\bdorcel|\bvivid\b|\bredlight|\bbabestation|\bfor adults|\berotic|\bsexy?\b|\bxx\b)/i;
const isAdultChannel = (name, category) => ADULT.test(name || '') || ADULT.test(category || '');

module.exports = { certToAge, AGE_LABEL, cleanTitle, parseM3uLibrary, libraryFor, lookup, isAdultChannel, libCache };
