// TFI Movies — keeps 8 public TMDB lists up to date (daily): 4 of movies, 4 of web series. It serves the
// same catalogs as a Stremio addon (backup), and as a Nuvio collection with covers drawn from each list.
// Runs as a single Vercel serverless function.

import { createHash } from "node:crypto";
import { LOGO_PNG_BASE64 } from "../lib/logo.js";
import { fetchNews, matchNews, matchSeriesNews, possiblyMissing, reviewHtml } from "../lib/news.js";

// ---------- Config (Vercel environment variables) ----------
const env = (k, d = "") => (process.env[k] ?? d).toString().trim();
const KEY = env("TMDB_API_KEY"); // v3 API key OR v4 "API Read Access Token"
const READ_TOKEN = env("TMDB_READ_TOKEN") || (KEY.startsWith("eyJ") ? KEY : ""); // needed once, to connect your account
const USER_TOKEN = env("TMDB_USER_TOKEN"); // from /tmdb-connect; lets the sync edit your lists
const CRON_SECRET = env("CRON_SECRET"); // optional; Vercel sends it to /sync automatically
const REGION = env("WATCH_REGION", "IN");
const LANG = env("META_LANGUAGE", "en-US");
const DUB_LANGS = env("DUB_SOURCE_LANGS", "ta|ml|kn");
const DUB_MIN_VOTES = env("DUB_MIN_VOTES", "3");
const EN_DUB_MIN_VOTES = env("EN_DUB_MIN_VOTES", "20");
const HINDI_MIN_VOTES = env("HINDI_MIN_VOTES", "0");
const MIN_RUNTIME = Number(env("MIN_RUNTIME", "60"));
const DUB_SERIES_MIN_VOTES = env("DUB_SERIES_MIN_VOTES", "0");
const EN_SERIES_MIN_VOTES = env("EN_SERIES_MIN_VOTES", "20");
const HINDI_SERIES_MIN_VOTES = env("HINDI_SERIES_MIN_VOTES", "0");
const SERIES_MAX_EPISODES = Number(env("SERIES_MAX_EPISODES", "40")); // a season longer than this is a TV serial / daily soap, not a web series
const SERIES_DAYS = 180; // shows with an episode in the last N days get their latest season's start date looked up
const CACHE_HOURS = Number(env("CACHE_HOURS", "6"));
const LIST_SIZE = Math.max(1, Math.min(Number(env("LIST_SIZE", "100")) || 100, 500));
const DIGITAL_DAYS = Number(env("DIGITAL_DAYS", "120")); // also include films with an Indian OTT release date in the last N days (0 = off)
const NEWS = env("NEWS_CHECK", "on") !== "off"; // also use OTT release news (Sacnilk, 123telugu, 91mobiles via a home server) to find films TMDB hasn't caught up on
const SACNILK_URL = env("NEWS_SACNILK_URL", "https://www.sacnilk.com/ott-movie-releases?type=recent&time_period=all&page={page}");
const TELUGU123_URL = env("NEWS_123TELUGU_URL", "https://www.123telugu.com/videos/ott");
const MOBILES91_URL = env("NEWS_91MOBILES_URL", "https://raw.githubusercontent.com/anonvibes/tfi-data/main/91mobiles.json"); // written daily by a home server
// Audio languages of each candidate (JustWatch and Netflix), checked daily by a home server from /candidates.json
const AUDIO_URL = env("AUDIO_URL", "https://raw.githubusercontent.com/anonvibes/tfi-data/main/audio.json");
const POOL_DAYS = Number(env("POOL_DAYS", "365")); // dubbed catalogs look this far back to fill up with titles that have Telugu audio
const POOL_PAGES = 25; // up to 500 candidates per dubbed catalog

const TMDB = env("TMDB_API_BASE", "https://api.themoviedb.org/3"); // overrides are for testing only
const TMDB4 = env("TMDB_API_BASE4", "https://api.themoviedb.org/4");
const IMG = "https://image.tmdb.org/t/p/";

const PAGE_SIZE = 100; // Stremio's catalog page size: fewer than 100 items = "end of catalog"
const TMDB_PAGE = 20; // TMDB discover returns 20 per page, max page 500
const CONCURRENCY = 8;

// Indian OTT platforms (matched by name, so renames like Hotstar -> JioHotstar keep working).
const PLATFORMS = [/netflix/i, /^amazon prime video|^prime video/i, /hotstar/i, /^aha\b/i, /zee5/i, /sony ?liv/i, /sun ?nxt/i, /etv ?win/i];
// The IDs those names gave for India on 2026-11-05 (themoviedb.org's provider filter). Used only when TMDB's
// provider list comes back empty, as it did that day, so a TMDB glitch doesn't stop the update.
const FALLBACK_PROVIDER_IDS = [8, 175, 119, 2100, 613, 2336, 232, 237, 2792, 309, 532];

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// Every title in every catalog has Telugu audio: Telugu originals, plus dubbed titles whose Telugu track is confirmed
// (JustWatch, Netflix or OTT news) or that no service lists audio languages for yet ("dubbed: true" catalogs).
// The catalog ids (and the Stremio ids) stay as they were; "key" is the short name used in configured addon links;
// "oldNames" are earlier TMDB list names, so the lists are renamed in place and keep their links.
const CATALOGS = {
  "tfi-streaming": {
    key: "te", name: "Telugu Movies", oldNames: ["Latest Streaming - TFI"],
    about: "Telugu films streaming on Indian OTT, latest arrivals first.",
    langs: () => ["te"], minVotes: () => 0,
  },
  "tfi-dubbed": {
    key: "south", name: "Telugu Dubbed: South", oldNames: ["Latest Dubbed - TFI"], dubbed: true,
    about: "Tamil, Malayalam and Kannada films with Telugu audio, streaming on Indian OTT, latest arrivals first.",
    langs: () => DUB_LANGS.split("|"), minVotes: () => Number(DUB_MIN_VOTES) || 0,
  },
  "tfi-english-dubbed": {
    key: "en", name: "Telugu Dubbed: English", oldNames: ["Latest English Dubbed - TFI"], dubbed: true,
    about: "English films with Telugu audio, streaming on Indian OTT, latest arrivals first.",
    langs: () => ["en"], minVotes: () => Number(EN_DUB_MIN_VOTES) || 0,
  },
  "hindi-streaming": {
    key: "hi", name: "Telugu Dubbed: Hindi", oldNames: ["Latest Streaming - Hindi"], dubbed: true,
    about: "Hindi films with Telugu audio, streaming on Indian OTT, latest arrivals first.",
    langs: () => ["hi"], minVotes: () => Number(HINDI_MIN_VOTES) || 0,
  },
};
// Web series (TMDB "tv"). Ranked by when the newest series or season started.
const SERIES = {
  "tfi-series": {
    key: "te-tv", name: "Telugu Series", oldNames: ["Latest Series - TFI"],
    about: "Telugu web series streaming on Indian OTT, newest series and seasons first.",
    langs: () => ["te"], minVotes: () => 0,
  },
  "tfi-dubbed-series": {
    key: "south-tv", name: "Telugu Dubbed Series: South", oldNames: ["Latest Dubbed Series - TFI"], dubbed: true,
    about: "Tamil, Malayalam and Kannada web series with Telugu audio, streaming on Indian OTT, newest series and seasons first.",
    langs: () => DUB_LANGS.split("|"), minVotes: () => Number(DUB_SERIES_MIN_VOTES) || 0,
  },
  "tfi-english-series": {
    key: "en-tv", name: "Telugu Dubbed Series: English", oldNames: ["Latest English Series - TFI"], dubbed: true,
    about: "English web series with Telugu audio, streaming on Indian OTT, newest series and seasons first.",
    langs: () => ["en"], minVotes: () => Number(EN_SERIES_MIN_VOTES) || 0,
  },
  "hindi-series": {
    key: "hi-tv", name: "Telugu Dubbed Series: Hindi", oldNames: ["Latest Series - Hindi"], dubbed: true,
    about: "Hindi web series with Telugu audio, streaming on Indian OTT, newest series and seasons first.",
    langs: () => ["hi"], minVotes: () => Number(HINDI_SERIES_MIN_VOTES) || 0,
  },
};
for (const [defs, media] of [[CATALOGS, "movie"], [SERIES, "tv"]]) for (const [id, def] of Object.entries(defs)) {
  def.id = id;
  def.media = media;
  def.query = () => ({ with_original_language: def.langs().join("|"), "vote_count.gte": def.minVotes() > 0 ? def.minVotes() : undefined });
}
const TV_TYPES = "0|2|4"; // Documentary, Miniseries, Scripted (not Reality, Talk Show, News or Video)
const TV_SKIP_GENRES = "10763|10764|10766|10767"; // News, Reality, Soap, Talk ("|": leave out a show with any of them)
// Reality and talk shows that TMDB types as "Scripted" with no genres (Bigg Boss Kannada: Agniparikshe, 2026-11-05)
const SERIES_SKIP_TITLES = new RegExp(env("SERIES_SKIP_TITLES",
  "bigg boss|indian idol|super singer|sa ?re ?ga ?ma ?pa|masterchef|khatron|roadies|splitsvilla|kaun banega|shark tank|cook with comali|\\bdhee\\b|koffee with|unstoppable with|comedy (nights|stars)|\\baward"), "i");
const skipTitle = (s) => SERIES_SKIP_TITLES.test(`${s.name || ""} ${s.original_name || ""}`);
// TV channels (TMDB network names): their shows are daily serials, not web series (Star Maa, Zee Telugu, 2026-11-15).
// OTT services (ETV Win, Zee5, Sun NXT) don't match.
const TV_CHANNELS = new RegExp(env("SERIES_TV_CHANNELS",
  "^(star ?maa|maa tv|zee telugu|gemini( tv)?|etv( telugu| plus)?|star ?plus|star bharat|star vijay|vijay tv|star suvarna|asianet|" +
  "colors( tv| kannada| tamil| marathi| bangla| rishtey)?|zee (tv|tamil|kannada|keralam|marathi|bangla)|sony (tv|entertainment television|sab)|" +
  "sab tv|&tv|and tv|sun tv|kalaignar tv|raj tv|surya tv|udaya tv|mazhavil manorama|flowers tv|dangal( tv)?|dd national|doordarshan)$"), "i");
// Does a film (from filmInfo) belong in this catalog? Same rules as the TMDB queries above.
const fits = (def, info) => info && info.primary && info.primary <= today() && def.langs().includes(info.lang) &&
  (info.votes || 0) >= def.minVotes() && !(MIN_RUNTIME > 0 && info.runtime && info.runtime < MIN_RUNTIME);

const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
  27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
  878: "Science Fiction", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
  // series genres
  10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy",
  10766: "Soap", 10767: "Talk", 10768: "War & Politics",
};

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------- TMDB v3 (read) ----------
async function tmdb(path, params = {}, attempt = 0) {
  if (!KEY) throw new Error("TMDB_API_KEY is not set");
  const url = new URL(TMDB + path);
  const headers = { accept: "application/json" };
  if (KEY.startsWith("eyJ")) headers.authorization = `Bearer ${KEY}`;
  else url.searchParams.set("api_key", KEY);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  let r;
  try { r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) }); }
  catch (e) { if (attempt < 1) { await sleep(300); return tmdb(path, params, attempt + 1); } throw new Error(`TMDB request failed on ${path}: ${e.message}`); }
  if ((r.status === 429 || r.status >= 500) && attempt < 1) { await sleep(Math.min(Number(r.headers.get("retry-after")) * 1000 || 1000, 3000)); return tmdb(path, params, attempt + 1); }
  if (!r.ok) throw new Error(`TMDB ${r.status} on ${path}`);
  return r.json();
}

// ---------- TMDB v4 (lists + account auth) ----------
async function tmdb4(method, path, token, body, attempt = 0) {
  const r = await fetch(TMDB4 + path, {
    method,
    headers: { accept: "application/json", "content-type": "application/json;charset=utf-8", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 2) { await sleep(1000 * (attempt + 1)); return tmdb4(method, path, token, body, attempt + 1); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`TMDB ${r.status} on ${method} ${path.split("?")[0]}: ${j.status_message || "error"}`);
  return j;
}

let providerCache = null;
async function getProviderIds() {
  if (providerCache && Date.now() - providerCache.at < 864e5) return providerCache.ids;
  const data = await tmdb("/watch/providers/movie", { watch_region: REGION });
  const ids = [...new Set((data.results || []).filter((r) => PLATFORMS.some((p) => p.test(r.provider_name || ""))).map((r) => r.provider_id))];
  if (!ids.length) {
    if (REGION !== "IN") throw new Error(`No OTT providers matched for region ${REGION}`);
    console.error(`TMDB gave ${(data.results || []).length} providers for IN, none matched; using the saved IDs`);
    providerCache = { at: Date.now() - 864e5 + 36e5, ids: FALLBACK_PROVIDER_IDS }; // ask TMDB again in an hour
    return FALLBACK_PROVIDER_IDS;
  }
  providerCache = { at: Date.now(), ids };
  return ids;
}

// Latest OTT arrivals for a catalog. Candidates: films TMDB lists as streaming in India, films with a recent
// Indian "Digital" (OTT) release date on TMDB, and films reported as new on OTT in the news (see lib/news.js).
// Ranking: the earliest Indian OTT date known (TMDB digital date or news date), otherwise the main release date.
// Dubbed catalogs take candidates from the last POOL_DAYS and keep only those with Telugu audio (see hasTelugu).
// The returned array carries .candidates (the count before that check), so the sync can tell a TMDB outage
// from a normal day.
async function discover(def, skip, count, news = newsMatches(), audio = null) {
  if (def.dubbed && !audio) audio = await getAudio();
  if (def.dubbed && !audio) return Object.assign([], { candidates: 0 });
  if (!def.dubbed && (skip >= 300 || !(DIGITAL_DAYS > 0))) return discoverOtt(def, skip, count);
  const [ott, digital] = await Promise.all([
    def.dubbed ? discoverOtt(def, 0, POOL_PAGES * TMDB_PAGE, daysAgo(POOL_DAYS)) : discoverOtt(def, 0, skip + count),
    digitalReleases(def)]);
  const inOtt = new Set(ott.map((m) => m.id));
  const newsDate = new Map(news.map((n) => [n.id, n.date]));
  const newsBy = new Map(news.map((n) => [n.id, n]));
  const seen = new Set();
  let pool = [...ott, ...digital].filter((m) => m && !seen.has(m.id) && seen.add(m.id));
  for (const n of news) if (!seen.has(n.id)) { seen.add(n.id); pool.push({ id: n.id, viaNews: true }); }
  const candidates = pool.length;
  if (def.dubbed) pool = pool.filter((m) => hasTelugu(audio, "movie", m.id, newsBy.get(m.id)));
  const recent = daysAgo(365); // older films keep their main release date, so re-released classics don't jump to the top
  const infos = await mapLimit(pool, CONCURRENCY, (m) =>
    inOtt.has(m.id) && (m.release_date || "") < recent && !newsDate.has(m.id) ? null : filmInfo(m.id));
  const ranked = pool.map((m, i) => {
    const info = infos[i];
    if (!inOtt.has(m.id) && !info) return null; // early OTT arrival we couldn't verify
    if (m.viaNews && !fits(def, info)) return null; // news film for another list (or a short, etc.)
    const item = m.viaNews ? info.item : m;
    const primary = (info?.primary || m.release_date || "").slice(0, 10);
    const ottKnown = [info?.digital, newsDate.get(m.id)].filter((d) => d && d >= primary).sort()[0];
    const ottDate = ottKnown && primary >= recent ? ottKnown : primary;
    return { ...item, release_date: primary, ott_date: ottDate, via_news: !!m.viaNews };
  }).filter(Boolean);
  ranked.sort((a, b) => b.ott_date.localeCompare(a.ott_date) || b.release_date.localeCompare(a.release_date));
  return Object.assign(ranked.slice(skip, skip + count), { candidates });
}

// Main release date, earliest Indian digital (OTT) release date so far, and IMDb id — one TMDB call per film.
const infoCache = new Map();
async function filmInfo(id) {
  const c = infoCache.get(id);
  if (c && Date.now() - c.at < 6 * 3600e3) return c;
  try {
    const d = await tmdb(`/movie/${id}`, { append_to_response: "release_dates", language: LANG });
    const t = today();
    const local = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === REGION)?.release_dates || [];
    const digital = local.filter((r) => r.type === 4 && r.release_date).map((r) => r.release_date.slice(0, 10)).filter((x) => x <= t).sort()[0] || null;
    const imdb = /^tt\d+$/.test(d.imdb_id || "") ? d.imdb_id : null;
    const item = { id: d.id, title: d.title, original_title: d.original_title, poster_path: d.poster_path, backdrop_path: d.backdrop_path,
      overview: d.overview, release_date: d.release_date, vote_average: d.vote_average, genre_ids: (d.genres || []).map((g) => g.id) };
    const v = { at: Date.now(), primary: d.release_date || null, digital, imdb, lang: d.original_language, runtime: d.runtime || 0, votes: d.vote_count || 0, item };
    if (infoCache.size > 20000) infoCache.clear();
    infoCache.set(id, v);
    imdbCache.set(`movie:${id}`, imdb);
    return v;
  } catch {
    return null;
  }
}

async function digitalReleases(def) {
  try {
    const params = {
      sort_by: "primary_release_date.desc",
      ...def.query(),
      region: REGION,
      with_release_type: 4, // Digital
      "release_date.gte": daysAgo(DIGITAL_DAYS),
      "release_date.lte": today(),
      "primary_release_date.gte": daysAgo(365), // new films only, not old ones re-released on OTT
      "primary_release_date.lte": today(),
      "with_runtime.gte": MIN_RUNTIME > 0 ? MIN_RUNTIME : undefined,
      include_adult: false,
      language: LANG,
    };
    const first = await tmdb("/discover/movie", { ...params, page: 1 });
    const pages = [];
    for (let p = 2; p <= Math.min(first.total_pages || 1, 5); p++) pages.push(p);
    const more = await mapLimit(pages, CONCURRENCY, (page) => tmdb("/discover/movie", { ...params, page }));
    return [first, ...more].flatMap((d) => d.results || []);
  } catch (e) {
    console.error("digital releases skipped:", e.message);
    return [];
  }
}

// What's streaming in India for a catalog, newest first (movies by release date, series by first episode),
// optionally only titles released (or started) on or after `since`.
async function ottParams(def, since) {
  const common = {
    ...def.query(),
    watch_region: REGION,
    with_watch_providers: (await getProviderIds()).join("|"),
    with_watch_monetization_types: "flatrate|free|ads",
    include_adult: false,
    language: LANG,
  };
  if (def.media === "tv") return { sort_by: "first_air_date.desc", ...common, "first_air_date.lte": today(), "first_air_date.gte": since,
    with_type: TV_TYPES, without_genres: TV_SKIP_GENRES, include_null_first_air_dates: false };
  return { sort_by: "primary_release_date.desc", ...common, "primary_release_date.lte": today(), "primary_release_date.gte": since,
    "with_runtime.gte": MIN_RUNTIME > 0 ? MIN_RUNTIME : undefined };
}

async function discoverOtt(def, skip, count, since) {
  const path = `/discover/${def.media}`;
  const firstPage = Math.floor(skip / TMDB_PAGE) + 1;
  const lastPage = Math.min(Math.floor((skip + count - 1) / TMDB_PAGE) + 1, 500);
  if (firstPage > 500) return [];
  const params = await ottParams(def, since);
  const first = await tmdb(path, { ...params, page: firstPage });
  const available = Math.min(first.total_pages || 1, 500);
  const lastFetched = Math.min(available, lastPage);
  const pages = [];
  for (let p = firstPage + 1; p <= lastFetched; p++) pages.push(p);
  const more = await mapLimit(pages, CONCURRENCY, (page) => tmdb(path, { ...params, page }));
  const seen = new Set();
  const dedupe = (list) => list.filter((m) => m && !seen.has(m.id) && seen.add(m.id));
  let movies = dedupe([first, ...more].flatMap((d) => d.results || []).slice(skip - (firstPage - 1) * TMDB_PAGE));
  if (movies.length < count && lastFetched < available) { // top up if duplicates were dropped
    const extra = await tmdb(path, { ...params, page: lastFetched + 1 });
    movies = movies.concat(dedupe(extra.results || []));
  }
  return movies.slice(0, count);
}

// ---------- Series ----------
// Latest web series for a catalog. A show ranks by the start of its newest season, so a new season of an
// old show comes up next to brand-new shows. Every show's details are looked up, for its seasons and to leave out
// TV serials (daily soaps), which TMDB types as "Scripted" dramas like any web series.
// Series reported as new on OTT in the news are added too (TMDB often misses aha / ETV Win originals). Their news date
// is used when TMDB has no started season for them yet, or only an older season than the news reports.
async function discoverSeries(def, skip, count, news = seriesNewsMatches(), audio = null) {
  if (def.dubbed && !audio) audio = await getAudio();
  if (def.dubbed && !audio) return Object.assign([], { candidates: 0 });
  if (!def.dubbed && skip >= 300) {
    const list = (await discoverOtt(def, skip, count)).filter((s) => !skipTitle(s));
    const infos = await mapLimit(list, CONCURRENCY, (s) => showInfo(s.id));
    return list.filter((s, i) => infos[i] && !infos[i].serial);
  }
  const [newest, airing] = await Promise.all([
    def.dubbed ? discoverOtt(def, 0, POOL_PAGES * TMDB_PAGE, daysAgo(POOL_DAYS)) : discoverOtt(def, 0, skip + count),
    recentlyAiring(def)]);
  const airingIds = new Set(airing.map((s) => s.id));
  const newsBy = new Map();
  for (const n of news) if (!newsBy.has(n.id) || (n.season || 1) > (newsBy.get(n.id).season || 1)) newsBy.set(n.id, { ...n, teAudio: n.teAudio || newsBy.get(n.id)?.teAudio });
  const seen = new Set();
  let pool = [...airing, ...newest].filter((s) => s && !seen.has(s.id) && seen.add(s.id) && !skipTitle(s));
  for (const id of newsBy.keys()) if (!seen.has(id)) { seen.add(id); pool.push({ id, viaNews: true }); }
  const candidates = pool.length;
  if (def.dubbed) pool = pool.filter((s) => hasTelugu(audio, "tv", s.id, newsBy.get(s.id)));
  // Every show is looked up (cached for 6 hours): TV serials are only told apart by their details. A show whose
  // lookup failed is left out rather than listed unchecked (soaps got in that way, 2026-11-15); the sync's
  // "kept as it was" check covers a TMDB outage.
  const infos = await mapLimit(pool, CONCURRENCY, (s) => showInfo(s.id));
  const ranked = pool.map((s, i) => {
    const info = infos[i];
    if (!info || info.serial) return null;
    if (s.viaNews && !(info && def.langs().includes(info.lang) && info.votes >= def.minVotes() && !skipTitle(info.item))) return null;
    const first = (s.first_air_date || "").slice(0, 10);
    const n = newsBy.get(s.id);
    const useNews = n && (!info?.seasonDate || (n.season || 1) > info.season);
    return { ...(info?.item || s), ott_date: useNews ? n.date : info?.seasonDate || first, season: useNews ? n.season || 1 : info?.season || 1, via_news: !!s.viaNews };
  }).filter((s) => s && !(def.dubbed && s.ott_date < daysAgo(POOL_DAYS)));
  ranked.sort((a, b) => b.ott_date.localeCompare(a.ott_date) || (b.first_air_date || "").localeCompare(a.first_air_date || ""));
  return Object.assign(ranked.slice(skip, skip + count), { candidates });
}

// Shows on Indian OTT with an episode in the last SERIES_DAYS days (up to 200, most popular first).
async function recentlyAiring(def) {
  try {
    const params = { ...(await ottParams(def)), sort_by: "popularity.desc", "air_date.gte": daysAgo(SERIES_DAYS), "air_date.lte": today() };
    const first = await tmdb("/discover/tv", { ...params, page: 1 });
    const pages = [];
    for (let p = 2; p <= Math.min(first.total_pages || 1, 10); p++) pages.push(p);
    const more = await mapLimit(pages, CONCURRENCY, (page) => tmdb("/discover/tv", { ...params, page }));
    return [first, ...more].flatMap((d) => d.results || []);
  } catch (e) {
    console.error("recently airing series skipped:", e.message);
    return [];
  }
}

// Newest season that has started, whether it's a TV serial rather than a web series, and IMDb id.
const showCache = new Map();
async function showInfo(id) {
  const c = showCache.get(id);
  if (c && Date.now() - c.at < 6 * 3600e3) return c;
  try {
    const d = await tmdb(`/tv/${id}`, { append_to_response: "external_ids", language: LANG });
    const t = today();
    const seasons = (d.seasons || []).filter((s) => s.season_number > 0);
    const latest = seasons.filter((s) => s.air_date && s.air_date <= t).sort((a, b) => b.air_date.localeCompare(a.air_date))[0];
    // Daily soaps have hundreds of episodes a season (a season's own count can lag behind the show's total:
    // Karthika Deepam, 2 vs 347), or air on a TV channel; reality and talk shows are typed as such on TMDB.
    // Bulk-added TV serials often have just 1 or 2 episodes and no network on TMDB, which no web series that started
    // months ago has (24 such serials in Telugu Series on 2026-11-15; its real web series had 4 episodes or more).
    const networks = (d.networks || []).map((n) => n.name || "");
    const episodes = d.number_of_episodes || seasons.reduce((a, s) => a + (s.episode_count || 0), 0);
    const stub = episodes <= 2 && !networks.length && !!d.first_air_date && d.first_air_date < daysAgo(90);
    const serial = (SERIES_MAX_EPISODES > 0 && (seasons.some((s) => s.episode_count > SERIES_MAX_EPISODES) ||
        episodes > SERIES_MAX_EPISODES * Math.max(1, seasons.length))) ||
      networks.some((n) => TV_CHANNELS.test(n)) || stub ||
      /reality|talk|news|video/i.test(d.type || "") || (d.genres || []).some((g) => [10763, 10764, 10766, 10767].includes(g.id));
    const imdb = /^tt\d+$/.test(d.external_ids?.imdb_id || "") ? d.external_ids.imdb_id : null;
    const item = { id: d.id, name: d.name, original_name: d.original_name, poster_path: d.poster_path, backdrop_path: d.backdrop_path,
      overview: d.overview, first_air_date: d.first_air_date, vote_average: d.vote_average, genre_ids: (d.genres || []).map((g) => g.id) };
    const v = { at: Date.now(), season: latest?.season_number || (d.first_air_date && d.first_air_date <= t ? 1 : 0),
      seasonDate: latest?.air_date || (d.first_air_date && d.first_air_date <= t ? d.first_air_date : null),
      serial, imdb, lang: d.original_language, votes: d.vote_count || 0, item };
    if (showCache.size > 20000) showCache.clear();
    showCache.set(id, v);
    imdbCache.set(`tv:${id}`, imdb);
    return v;
  } catch {
    return null;
  }
}

// ---------- News check (cached for the day; the daily sync refreshes it) ----------
let newsCache = null;
const newsMatches = () => (newsCache && Date.now() - newsCache.at < 26 * 3600e3 ? newsCache.matched : []);
async function getNews(force = false) {
  if (!NEWS) return { matched: [], unsure: [], notFound: [], stats: { off: true } };
  if (!force && newsCache && Date.now() - newsCache.at < 3600e3) return newsCache;
  const { entries, stats } = await fetchNews({ sacnilkUrl: SACNILK_URL, teluguUrl: TELUGU123_URL, mobiles91Url: MOBILES91_URL, days: DIGITAL_DAYS || 120, todayStr: today() });
  const result = await matchNews(entries, { tmdb, mapLimit });
  newsCache = { at: Date.now(), ...result, stats: { ...stats, entries: entries.length, matched: result.matched.length, unsure: result.unsure.length, notFound: result.notFound.length } };
  return newsCache;
}

// Series from the news: 123telugu and 91mobiles (Sacnilk's listing has films only)
let seriesNewsCache = null;
const seriesNewsMatches = () => (seriesNewsCache && Date.now() - seriesNewsCache.at < 26 * 3600e3 ? seriesNewsCache.matched : []);
async function getSeriesNews(force = false) {
  if (!NEWS) return { matched: [], unsure: [], notFound: [], stats: { off: true } };
  if (!force && seriesNewsCache && Date.now() - seriesNewsCache.at < 3600e3) return seriesNewsCache;
  const { entries, stats } = await fetchNews({ teluguUrl: TELUGU123_URL, mobiles91Url: MOBILES91_URL, days: DIGITAL_DAYS || 120, todayStr: today(), type: "series" });
  const result = await matchSeriesNews(entries, { tmdb, mapLimit });
  seriesNewsCache = { at: Date.now(), ...result, stats: { ...stats, entries: entries.length, matched: result.matched.length, unsure: result.unsure.length, notFound: result.notFound.length } };
  return seriesNewsCache;
}

// ---------- Telugu audio ----------
// audio.json: { updated, movie: { "<tmdb id>": { te: true | false | null, ... } }, tv: { ... } }. te is true when
// JustWatch or Netflix lists Telugu audio, false when they list the audio languages without Telugu, and null when
// no service lists them (mostly Sun NXT); `justwatch: "not found"` marks titles JustWatch doesn't have. It's written
// outside this app, so only those two fields are read from it.
let audioCache = null;
async function getAudio() {
  if (audioCache && Date.now() - audioCache.at < 600e3) return audioCache.data;
  try {
    const r = await fetch(AUDIO_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j || typeof j.movie !== "object" || typeof j.tv !== "object") throw new Error("unexpected format");
    audioCache = { at: Date.now(), data: { movie: j.movie, tv: j.tv, updated: String(j.updated || "").slice(0, 10) } };
    return audioCache.data;
  } catch (e) {
    console.error("audio check unavailable:", e.message);
    return audioCache?.data || null;
  }
}

// Belongs in a dubbed catalog: the audio check found Telugu, or JustWatch has the title but no service lists its
// audio languages (mostly Sun NXT), or the news reports Telugu audio. The streaming service's own list beats the
// news (Sacnilk gave Telugu for a Netflix film whose Netflix page lists Malayalam only, 2026-11-06). Titles JustWatch
// doesn't know at all (mostly obscure films and stand-up specials) need the news, and so do titles neither has
// covered yet, until the next check.
function hasTelugu(audio, media, id, news) {
  const a = audio?.[media]?.[id];
  const checked = !!a && typeof a === "object";
  if (checked && a.te === false) return false;
  if (checked && a.te !== true && a.justwatch === "not found") return !!news?.teAudio;
  return checked || !!news?.teAudio;
}

// Everything the dubbed catalogs could include, before the Telugu-audio check. A home server checks these daily
// (JustWatch and Netflix list audio languages) and publishes the results as audio.json.
async function candidates(media) {
  const isTv = media === "tv";
  const news = await (isTv ? getSeriesNews : getNews)().catch(() => ({ matched: [] }));
  const out = new Map();
  const add = (id, title, original, date, lang) => {
    if (Number.isInteger(id) && !out.has(id)) out.set(id, { id, title: title || original || "", original_title: original || null, year: Number(String(date || "").slice(0, 4)) || null, lang: lang || null });
  };
  for (const def of Object.values(isTv ? SERIES : CATALOGS).filter((d) => d.dubbed)) {
    const [main, extra] = await Promise.all([discoverOtt(def, 0, POOL_PAGES * TMDB_PAGE, daysAgo(POOL_DAYS)), isTv ? recentlyAiring(def) : digitalReleases(def)]);
    for (const m of [...main, ...extra]) if (m && !(isTv && skipTitle(m))) add(m.id, m.title || m.name, m.original_title || m.original_name, m.release_date || m.first_air_date, m.original_language);
    for (const n of news.matched || []) if (def.langs().includes(n.lang)) add(n.id, n.tmdbTitle, null, n.date, n.lang);
  }
  return { generated_at: new Date().toISOString(), media, count: out.size, items: [...out.values()] };
}

// ---------- List sync ----------
function accountIdFromToken(token) {
  if (env("TMDB_ACCOUNT_ID")) return env("TMDB_ACCOUNT_ID");
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).sub || null; } catch { return null; }
}

async function allPages(path, token) {
  const out = [];
  for (let page = 1, total = 1; page <= total && page <= 50; page++) {
    const d = await tmdb4("GET", `${path}${path.includes("?") ? "&" : "?"}page=${page}`, token);
    out.push(...(d.results || []));
    total = d.total_pages || 1;
  }
  return out;
}

// media "movie": the 4 movie lists (/sync); "tv": the 4 series lists (/sync-series)
async function syncLists(media = "movie") {
  if (!USER_TOKEN) throw new Error("TMDB_USER_TOKEN is not set. Open /tmdb-connect once to create it.");
  const account = accountIdFromToken(USER_TOKEN);
  if (!account) throw new Error("Could not read the account id from TMDB_USER_TOKEN");
  const mine = await allPages(`/account/${account}/lists`, USER_TOKEN);
  const isTv = media === "tv";
  const count = isTv ? "series" : "movies";
  let news = { matched: [], unsure: [], notFound: [], stats: {} };
  try { news = await (isTv ? getSeriesNews : getNews)(true); } catch (e) { news.stats = { error: e.message }; }
  const audio = await getAudio();
  const report = [];
  for (const def of Object.values(isTv ? SERIES : CATALOGS)) {
    let list = mine.find((l) => l.name === def.name) || mine.find((l) => def.oldNames.includes(l.name));
    if (def.dubbed && !audio) {
      report.push({ list: def.name, ...(list ? { url: `https://www.themoviedb.org/list/${list.id}` } : {}), note: "kept as it was: the Telugu audio check (audio.json) couldn't be read" });
      continue;
    }
    const ranked = isTv ? await discoverSeries(def, 0, LIST_SIZE, news.matched, audio) : await discover(def, 0, LIST_SIZE, news.matched, audio);
    const wanted = ranked.map((m) => m.id);
    const fromNews = ranked.filter((m) => m.via_news).map((m) => m.title);
    const description = `${def.about} Updated automatically every day by TFI Movies. Last update: ${today()}.`;
    let current = [];
    if (!list) {
      // TMDB refused the full request for the series lists on 2026-11-05 ("Validation failed"), so fall back to
      // the docs' example body; the description is set by the PUT further down either way.
      let created = null, err = null;
      for (const body of [{ name: def.name, iso_639_1: "en", description, public: true },
        { name: def.name, iso_639_1: "en", iso_3166_1: "US", description: "", public: true }]) {
        try { created = await tmdb4("POST", "/list", USER_TOKEN, body); break; } catch (e) { err = e; }
      }
      if (!created?.id) { report.push({ list: def.name, [count]: 0, note: `could not create the list: ${err?.message || "no id returned"}` }); continue; }
      list = { id: created.id };
    } else {
      current = await allPages(`/list/${list.id}`, USER_TOKEN);
    }
    // A list that suddenly shrinks means TMDB returned too little (as when its streaming data goes missing):
    // keep the current list until TMDB recovers rather than emptying it. Dubbed lists shrink when titles without
    // Telugu audio drop out, so for them it's the candidate count (before the audio check) that has to hold up;
    // it can be small (24 Tamil/Malayalam/Kannada series and 91 Hindi films on 2026-11-06), but not near zero.
    const tooFew = def.dubbed ? ranked.candidates < 10 : wanted.length < current.length * 0.8;
    if (current.length >= 50 && tooFew) {
      report.push({ list: def.name, url: `https://www.themoviedb.org/list/${list.id}`, [count]: current.length, added: 0, removed: 0, reordered: false, ...(isTv ? {} : { from_news: [] }), note: `kept as it was: TMDB gave only ${def.dubbed ? ranked.candidates : wanted.length} ${isTv ? "series" : "films"}` });
      continue;
    }
    const want = new Set(wanted);
    const currentIds = current.filter((i) => (i.media_type || "movie") === media).map((i) => i.id);
    const have = new Set(currentIds);
    const added = wanted.filter((id) => !have.has(id)).length;
    const removed = current.length - currentIds.filter((id) => want.has(id)).length;
    // The list shows items in the order they were added, so when anything changes, rebuild it in ranked order.
    const unchanged = current.length === wanted.length && currentIds.length === wanted.length && currentIds.every((id, i) => id === wanted[i]);
    let notAdded = [], orderNote;
    if (!unchanged) {
      // Delete the items one batch at a time, not with /clear. TMDB finishes deleting a moment later, and a batch
      // added before then is refused as duplicates (or wiped), so wait until the list reads as empty.
      const empty = async (items) => {
        if (!items.length) return;
        const all = items.map((i) => ({ media_type: i.media_type || "movie", media_id: i.id }));
        for (const c of chunks(all, 50)) await tmdb4("DELETE", `/list/${list.id}/items`, USER_TOKEN, { items: c });
        for (let i = 0; i < 10; i++) {
          await sleep(1500);
          const l = await tmdb4("GET", `/list/${list.id}?page=1`, USER_TOKEN).catch(() => null);
          if (l && !(l.total_results > 0)) break;
        }
      };
      const add = async (ids) => {
        const failed = [];
        for (const c of chunks(ids, 50)) {
          const r = await tmdb4("POST", `/list/${list.id}/items`, USER_TOKEN, { items: c.map((id) => ({ media_type: media, media_id: id })) });
          failed.push(...(r.results || []).filter((x) => x.success === false).map((x) => x.media_id));
        }
        return failed;
      };
      // The list shows items in the order they were added, so adding refused items afterwards puts them at the
      // end: on 2026-11-20 that put the newest 50 films below the other 50. So read the list back, and rebuild it
      // when the order is off or TMDB refused films that it may take on a second try (not the same ones again).
      let items = current, prev = null, inOrder = false;
      for (let tries = 0; tries < 3; tries++) {
        if (tries) await sleep(3000);
        await empty(items);
        notAdded = await add(wanted);
        items = await allPages(`/list/${list.id}`, USER_TOKEN).catch(() => []);
        const got = items.filter((i) => (i.media_type || "movie") === media).map((i) => i.id);
        const expect = wanted.filter((id) => !notAdded.includes(id));
        inOrder = got.length === expect.length && got.every((id, i) => id === expect[i]);
        const sameRefused = prev && prev.length === notAdded.length && notAdded.every((id) => prev.includes(id));
        if (inOrder && (!notAdded.length || sameRefused)) break;
        prev = notAdded;
      }
      if (notAdded.length) { await sleep(2000); notAdded = await add(notAdded); } // at the end, as TMDB refused them in place
      if (!inOrder) orderNote = "the list may be out of order (TMDB didn't keep the order it was added in)";
    }
    let note = [notAdded.length ? `TMDB refused ${notAdded.length} ${count}: ${notAdded.join(", ")}` : null, orderNote].filter(Boolean).join("; ") || undefined;
    try { await tmdb4("PUT", `/list/${list.id}`, USER_TOKEN, { name: def.name, description, public: true, sort_by: "original_order.asc" }); }
    catch (e) { note = [note, `list settings not updated: ${e.message}`].filter(Boolean).join("; "); }
    report.push({ list: def.name, url: `https://www.themoviedb.org/list/${list.id}`, [count]: wanted.length, added, removed, reordered: !unchanged,
      ...(def.dubbed ? { telugu_audio: { candidates: ranked.candidates, audio_checked: audio.updated } } : {}),
      ...(isTv ? { top: ranked.slice(0, 5).map((s) => `${s.name} S${s.season} (${s.ott_date})`), from_news: ranked.filter((s) => s.via_news).map((s) => s.name) } : { from_news: fromNews }), ...(note ? { note } : {}) });
  }
  if (isTv) {
    const { telugu123: { sample: _s, ...telugu123 } = {}, notFound: _n, ...stats } = news.stats;
    const brief = (e) => `${e.title} (${e.platform}, ${e.date})`;
    return { ok: true, synced_at: new Date().toISOString(), lists: report,
      news: { ...stats, telugu123, unsure: (news.unsure || []).map(brief), not_found: (news.notFound || []).map(brief) } };
  }
  const { sample: _a, ...sacnilk } = news.stats.sacnilk || {};
  const { sample: _b, ...telugu123 } = news.stats.telugu123 || {};
  return { ok: true, synced_at: new Date().toISOString(), lists: report,
    news: { ...news.stats, sacnilk, telugu123, review: "/review" } };
}

// Current contents of your TMDB lists (used by the addon and the review page)
let listIndex = null;
async function findList(def) {
  if (!USER_TOKEN) return null;
  if (!listIndex || Date.now() - listIndex.at > 3600e3) {
    const account = accountIdFromToken(USER_TOKEN);
    listIndex = { at: Date.now(), lists: await allPages(`/account/${account}/lists`, USER_TOKEN) };
  }
  return listIndex.lists.find((l) => l.name === def.name) || listIndex.lists.find((l) => def.oldNames.includes(l.name)) || null;
}
async function listItems(def) {
  const list = await findList(def);
  return list ? allPages(`/list/${list.id}?language=${LANG}`, USER_TOKEN) : null;
}

async function review() {
  const [news, lists] = await Promise.all([
    getNews().catch((e) => ({ matched: [], unsure: [], notFound: [], stats: { error: e.message } })),
    Promise.all(Object.values(CATALOGS).map((def) => listItems(def).catch(() => null))),
  ]);
  const inLists = new Set(lists.flat().filter(Boolean).map((i) => i.id));
  const exclude = new Set([...inLists, ...news.matched.map((m) => m.id)]);
  const isCovered = async (id) => {
    const r = (await tmdb(`/movie/${id}/watch/providers`)).results?.[REGION] || {};
    const names = [...(r.flatrate || []), ...(r.free || []), ...(r.ads || [])].map((p) => p.provider_name || "");
    return names.some((n) => PLATFORMS.some((p) => p.test(n))) || !!(await filmInfo(id))?.digital;
  };
  const missing = await possiblyMissing({
    tmdb, exclude, todayStr: today(), isCovered,
    groups: [{ label: "Telugu", langs: ["te"] }, { label: "Tamil / Malayalam / Kannada", langs: DUB_LANGS.split("|") }, { label: "Hindi", langs: ["hi"] }],
  });
  return { news, missing, inLists };
}

// ---------- Stremio addon (backup) ----------
const imdbCache = new Map(); // keyed "movie:<id>" / "tv:<id>" (TMDB reuses numbers across the two)
async function imdbId(tmdbId, media = "movie") {
  const key = `${media}:${tmdbId}`;
  if (imdbCache.has(key)) return imdbCache.get(key);
  try {
    const ids = await tmdb(`/${media}/${tmdbId}/external_ids`);
    const v = /^tt\d+$/.test(ids.imdb_id || "") ? ids.imdb_id : null;
    if (imdbCache.size > 20000) imdbCache.clear();
    imdbCache.set(key, v);
    return v;
  } catch { return null; }
}

function toPreview(m, imdb, type = "movie") {
  return {
    id: imdb || `tmdb:${m.id}`,
    type,
    name: m.title || m.name || m.original_title || m.original_name,
    poster: m.poster_path ? `${IMG}w342${m.poster_path}` : undefined,
    background: m.backdrop_path ? `${IMG}w1280${m.backdrop_path}` : undefined,
    description: m.overview || undefined,
    releaseInfo: (m.release_date || m.first_air_date || "").slice(0, 4) || undefined,
    imdbRating: m.vote_average ? m.vote_average.toFixed(1) : undefined,
    genres: (m.genre_ids || []).map((g) => GENRES[g]).filter(Boolean),
  };
}

// ---------- Choosing catalogs ----------
// A configured addon link names its catalogs in the first path segment, in the order Stremio shows them:
// /te,south,te-tv/manifest.json. The plain /manifest.json has all of them in the default order.
const ALL_DEFS = [...Object.values(CATALOGS), ...Object.values(SERIES)];
const ALL_KEYS = ALL_DEFS.map((d) => d.key);
function parseConfig(segment) {
  const keys = [...new Set(decodeSeg(segment).split(",").filter(Boolean))];
  return keys.length && keys.every((k) => ALL_KEYS.includes(k)) ? keys : null;
}
const configPath = (keys) => (!keys || keys.join(",") === ALL_KEYS.join(",") ? "" : `/${keys.join(",")}`);

function manifest(base, keys = ALL_KEYS) {
  const defs = keys.map((k) => ALL_DEFS.find((d) => d.key === k));
  const types = [...new Set(defs.map((d) => (d.media === "tv" ? "series" : "movie")))];
  return {
    id: "community.tfi.movies",
    version: "2.8.0",
    name: "TFI Movies",
    description: "Movies and web series that most probably have Telugu audio, new on Indian OTT: the latest Telugu releases, plus Tamil, Malayalam, Kannada, English and Hindi titles dubbed in Telugu. Whether you get the Telugu track depends on your stream addons and their settings. Refreshed every day. Metadata by TMDB. Made with the help of AI.",
    logo: `${base}/tfi-logo.png`,
    resources: ["catalog", { name: "meta", types, idPrefixes: ["tmdb:"] }],
    types,
    idPrefixes: ["tmdb:"],
    catalogs: defs.map((d) => ({ type: d.media === "tv" ? "series" : "movie", id: d.id, name: d.name, extra: [{ name: "skip" }] })),
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// A catalog's titles from `skip` on. The first page is the TMDB list itself, so the addon shows what the list shows.
async function catalogItems(def, skip = 0) {
  let items = null;
  if (skip === 0) items = await listItems(def).then((l) => (l && l.length ? l.filter((i) => (i.media_type || "movie") === def.media) : null)).catch(() => null);
  return items || (def.media === "tv" ? discoverSeries(def, skip, PAGE_SIZE) : discover(def, skip, PAGE_SIZE));
}

async function catalog(type, id, extra) {
  const def = (type === "series" ? SERIES : CATALOGS)[id];
  if (!def) return null;
  const skipRaw = Number(extra.get("skip") || 0);
  const skip = Number.isFinite(skipRaw) ? Math.max(0, Math.floor(skipRaw)) : 0;
  const items = await catalogItems(def, skip);
  const ids = await mapLimit(items, CONCURRENCY, (m) => imdbId(m.id, def.media));
  return { metas: items.map((m, i) => toPreview(m, ids[i], type)) };
}

// ---------- Nuvio collection ----------
// /nuvio-collections.json is a collection Nuvio can import: one folder per catalog. Each folder's art is at
// /art/<catalog key>/cover.webp (the tile), focus.gif (played while the tile has focus), backdrop.webp and logo.webp
// (Nuvio's big preview of the tile). The art is drawn from the list's newest titles (lib/art.js), so it changes
// when the list does. The links stay the same, so nobody has to import again.
const ART_FILES = { "cover.webp": "image/webp", "focus.gif": "image/gif", "backdrop.webp": "image/webp", "logo.webp": "image/webp" };
const ART_LANGS = { te: ["Telugu", "#a855f7"], south: ["South", "#34d399"], en: ["English", "#38bdf8"], hi: ["Hindi", "#fbbf24"] }; // words and colour on the tile
// The art changes only when the lists do, at the daily syncs (Vercel crons at 00:30 and 01:30 UTC, each may run up to an
// hour late). So apps and Vercel keep an image until 03:00 UTC (8:30 AM IST), then ask again; Nuvio swaps it when the
// ETag is new. Nuvio's phone app (Coil, CacheControlCacheStrategy) checks with us before showing an image whose max-age
// has run out, so with the old 1-hour max-age the tiles stayed blank for a moment on every app start (2026-11-20).
// No stale-while-revalidate: it would hand out yesterday's cover once more after each sync.
const ART_REFRESH_UTC_HOUR = 3;
function artCache(now = Date.now()) {
  const next = new Date(now);
  next.setUTCHours(ART_REFRESH_UTC_HOUR, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  const age = Math.max(300, Math.round((next.getTime() - now) / 1000));
  return `public, max-age=${age}, s-maxage=${age}, stale-if-error=604800`;
}

async function artSpec(def) {
  const items = await catalogItems(def);
  const [title, accent] = ART_LANGS[def.key.replace(/-tv$/, "")];
  const top = items.find((m) => m.backdrop_path);
  return {
    title, accent, kind: def.media === "tv" ? "Series" : "Movies", tag: def.dubbed ? "DUBBED IN TELUGU" : "MADE IN TELUGU", count: items.length,
    posters: items.filter((m) => m.poster_path).slice(0, 8).map((m) => `${IMG}w342${m.poster_path}`), // the fan shows 3, the GIF 5; the rest are spares
    backdrop: top ? `${IMG}w1280${top.backdrop_path}` : null,
  };
}

function nuvioCollection(base) {
  return [{
    id: "community.tfi.movies", title: "TFI Movies", backdropImageUrl: null, pinToTop: false, focusGlowEnabled: true, viewMode: "TABBED_GRID", showAllTab: true,
    folders: ALL_DEFS.map((d) => {
      const source = { addonId: manifest(base).id, type: d.media === "tv" ? "series" : "movie", catalogId: d.id };
      const art = `${base}/art/${d.key}`;
      return {
        id: `community.tfi.movies.${d.key}`, title: d.name, tileShape: "LANDSCAPE", hideTitle: true, coverEmoji: null,
        coverImageUrl: `${art}/cover.webp`, focusGifUrl: `${art}/focus.gif`, focusGifEnabled: true,
        heroBackdropUrl: `${art}/backdrop.webp`, titleLogoUrl: `${art}/logo.webp`, heroVideoUrl: null,
        sources: [{ provider: "addon", ...source }], catalogSources: [source], // older Nuvio versions read catalogSources
      };
    }),
  }];
}

async function meta(id) {
  const d = await tmdb(`/movie/${id.replace(/^tmdb:/, "")}`, { language: LANG, append_to_response: "credits,videos" });
  const trailer = (d.videos?.results || []).find((v) => v.site === "YouTube" && v.type === "Trailer");
  const cast = (d.credits?.cast || []).slice(0, 6).map((c) => c.name);
  const director = (d.credits?.crew || []).filter((c) => c.job === "Director").map((c) => c.name);
  const search = (n) => `stremio:///search?search=${encodeURIComponent(n)}`;
  return {
    meta: {
      id, type: "movie",
      name: d.title || d.original_title,
      poster: d.poster_path ? `${IMG}w500${d.poster_path}` : undefined,
      background: d.backdrop_path ? `${IMG}original${d.backdrop_path}` : undefined,
      description: d.overview || undefined,
      releaseInfo: (d.release_date || "").slice(0, 4) || undefined,
      released: d.release_date ? new Date(d.release_date).toISOString() : undefined,
      runtime: d.runtime ? `${d.runtime} min` : undefined,
      genres: (d.genres || []).map((g) => g.name),
      imdbRating: d.vote_average ? d.vote_average.toFixed(1) : undefined,
      cast, director,
      language: d.original_language,
      trailers: trailer ? [{ source: trailer.key, type: "Trailer" }] : [],
      trailerStreams: trailer ? [{ title: trailer.name, ytId: trailer.key }] : [],
      links: [
        ...(d.imdb_id ? [{ name: "IMDb", category: "imdb", url: `https://www.imdb.com/title/${d.imdb_id}/` }] : []),
        ...director.map((n) => ({ name: n, category: "director", url: search(n) })),
        ...cast.map((n) => ({ name: n, category: "actor", url: search(n) })),
      ],
    },
  };
}

// Only for series without an IMDb id (Stremio gets the rest from Cinemeta). Episodes are "tmdb:<id>:<season>:<episode>".
async function seriesMeta(id) {
  const tvId = id.replace(/^tmdb:/, "");
  const d = await tmdb(`/tv/${tvId}`, { language: LANG, append_to_response: "credits,videos,external_ids" });
  const seasonNums = (d.seasons || []).map((s) => s.season_number).filter((n) => n > 0);
  const withSeasons = await Promise.all(chunks(seasonNums, 20).map((c) =>
    tmdb(`/tv/${tvId}`, { language: LANG, append_to_response: c.map((n) => `season/${n}`).join(",") })));
  const fallback = d.first_air_date ? new Date(d.first_air_date).toISOString() : new Date().toISOString();
  const videos = withSeasons.flatMap((s) => seasonNums.flatMap((n) => s[`season/${n}`]?.episodes || [])).map((ep) => ({
    id: `${id}:${ep.season_number}:${ep.episode_number}`,
    title: ep.name || `Episode ${ep.episode_number}`,
    season: ep.season_number, episode: ep.episode_number,
    released: ep.air_date ? new Date(ep.air_date).toISOString() : fallback,
    overview: ep.overview || undefined,
    thumbnail: ep.still_path ? `${IMG}w300${ep.still_path}` : undefined,
  }));
  const trailer = (d.videos?.results || []).find((v) => v.site === "YouTube" && v.type === "Trailer");
  const cast = (d.credits?.cast || []).slice(0, 6).map((c) => c.name);
  const creators = (d.created_by || []).map((c) => c.name);
  const imdb = d.external_ids?.imdb_id;
  const search = (n) => `stremio:///search?search=${encodeURIComponent(n)}`;
  const year = (s) => (s || "").slice(0, 4);
  return {
    meta: {
      id, type: "series",
      name: d.name || d.original_name,
      poster: d.poster_path ? `${IMG}w500${d.poster_path}` : undefined,
      background: d.backdrop_path ? `${IMG}original${d.backdrop_path}` : undefined,
      description: d.overview || undefined,
      releaseInfo: d.first_air_date ? `${year(d.first_air_date)}–${d.in_production ? "" : year(d.last_air_date)}` : undefined,
      released: d.first_air_date ? new Date(d.first_air_date).toISOString() : undefined,
      runtime: d.episode_run_time?.[0] ? `${d.episode_run_time[0]} min` : undefined,
      genres: (d.genres || []).map((g) => g.name),
      imdbRating: d.vote_average ? d.vote_average.toFixed(1) : undefined,
      cast, director: creators,
      language: d.original_language,
      videos,
      trailers: trailer ? [{ source: trailer.key, type: "Trailer" }] : [],
      trailerStreams: trailer ? [{ title: trailer.name, ytId: trailer.key }] : [],
      links: [
        ...(imdb ? [{ name: "IMDb", category: "imdb", url: `https://www.imdb.com/title/${imdb}/` }] : []),
        ...creators.map((n) => ({ name: n, category: "director", url: search(n) })),
        ...cast.map((n) => ({ name: n, category: "actor", url: search(n) })),
      ],
    },
  };
}

// ---------- Pages ----------
function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/tfi-logo.png">
<style>:root{--bg:#fff;--fg:#111;--mut:#666;--box:#f3f3f5;--acc:#7b5bf5;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#eee;--mut:#aaa;--box:#1e1e22;color-scheme:dark}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;max-width:600px;margin:8vh auto;padding:0 16px}
a.btn{display:inline-block;background:var(--acc);color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600}
code,textarea{word-break:break-all;color:var(--mut)}textarea{width:100%;height:120px;background:var(--box);border:0;border-radius:8px;padding:10px;font:13px monospace}
.box{background:var(--box);border-radius:10px;padding:12px 16px}.mut{color:var(--mut);font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0 24px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--box);vertical-align:top}
a{color:var(--acc)}</style></head><body>${body}
<p class="mut">This product uses the TMDB API but is not endorsed or certified by TMDB.</p></body></html>`;
}

// The home page's board: the 3 newest Telugu movies, then the 3 newest South films dubbed in Telugu, each read from
// the first page of its TMDB list. Three TMDB calls at most (the list index, then the two pages), and the result is
// kept for an hour. A list that is missing or short is made up for from the other one.
const BOARD_EACH = 3;
let boardCache = null;
async function boardItems() {
  if (boardCache && Date.now() - boardCache.at < 3600e3) return boardCache.items;
  const firstPage = async (key) => {
    const list = await findList(ALL_DEFS.find((d) => d.key === key));
    const raw = list ? (await tmdb4("GET", `/list/${list.id}?language=${LANG}&page=1`, USER_TOKEN)).results || [] : [];
    return raw.filter((m) => (m.media_type || "movie") === "movie" && (m.title || m.original_title));
  };
  const te = await firstPage("te"); // first, so the list index is fetched once
  const south = await firstPage("south").catch(() => []);
  const picked = [...te.slice(0, BOARD_EACH), ...south.slice(0, BOARD_EACH)];
  for (const m of [...te.slice(BOARD_EACH), ...south.slice(BOARD_EACH)]) if (picked.length < BOARD_EACH * 2) picked.push(m);
  const seen = new Set();
  const items = picked.filter((m) => !seen.has(m.id) && seen.add(m.id)).map((m) => ({
    name: m.title || m.original_title,
    poster: /^\/[A-Za-z0-9]+\.jpg$/.test(m.poster_path || "") ? m.poster_path.slice(1) : null, // served from /poster/<file>
    genres: (m.genre_ids || []).map((g) => GENRES[g]).filter(Boolean).slice(0, 2),
    rating: m.vote_average ? m.vote_average.toFixed(1) : null,
  }));
  boardCache = { at: Date.now(), items };
  return items;
}

// What the home page shows besides its fixed text: the board, and links to the TMDB lists. A /configure page has
// neither and needs nothing.
async function landingData(home) {
  if (!home) return { board: [], lists: {} };
  const board = await boardItems(); // this reads the list index, so the links below cost no further TMDB calls
  const lists = {};
  for (const def of ALL_DEFS) { const list = await findList(def).catch(() => null); if (list) lists[def.key] = list.id; }
  return { board, lists };
}

const PLATFORM_NAMES = ["Netflix", "Prime Video", "JioHotstar", "aha", "ZEE5", "SonyLIV", "Sun NXT", "ETV Win"];
const REPO_URL = "https://github.com/anonvibes/TFI";
// Nuvio's public API, for the home page's "Add it to your Nuvio account": base URL and the publishable key Nuvio
// gives third-party clients in its docs (https://nuvio.tv/docs/server-api, v1.3). Public by design, not a secret.
const NUVIO_API = "https://api.nuvio.tv";
const NUVIO_KEY = "sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN";

// keys: the catalogs switched on, in the order Stremio shows them (a configured link's /configure page opens with its own choice)
// start: "cats" on a /configure page (Stremio's Configure button): the catalog list alone, already open
function landing(host, base, data, keys = ALL_KEYS, start = "app") {
  const cfg = configPath(keys);
  const manifestUrl = `${base}${cfg}/manifest.json`;
  // One install link for every app: Stremio, Nuvio and other apps that take Stremio addons all open stremio://
  // links, and the phone or computer asks which app when there are several.
  const appInstall = `stremio://${host}${cfg}/manifest.json`;
  const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const keysOf = (f) => ALL_DEFS.filter(f).map((d) => d.key);
  const presets = {
    telugu: ["Telugu originals", keysOf((d) => !d.dubbed)],
    movies: ["Movies only", keysOf((d) => d.media === "movie")],
    series: ["Series only", keysOf((d) => d.media === "tv")],
  };
  const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
  const names = Object.fromEntries(ALL_DEFS.map((d) => [d.key, [d.name, d.media === "tv" ? "Series" : "Movies"]]));
  const icon = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const ast = `<sup><a class="ast" href="#note" aria-label="About Telugu audio">*</a></sup>`;
  const desc = "Free Stremio addon: movies and web series that most probably have Telugu audio, new on Indian OTT. Telugu originals plus Tamil, Malayalam, Kannada, English and Hindi titles dubbed in Telugu. Refreshed every day.";
  // The home page: Install and Configure under the headline, the board, then the Nuvio collections section. A
  // /configure page (Stremio's Configure button) is the catalog list alone, already open.
  const home = start === "app";
  const board = home && Array.isArray(data.board) && data.board.length >= 6 ? data.board : [];
  const plus = icon("M8 3v10M3 8h10");
  // The addon link to copy, under an Install button. Its line turns into the "Not working?" hint after a tap on Install.
  const linkBox = (main) => `<p class="hint" role="status">Or copy this link and add it in your app's Addons section.</p>
    <div class="copy"><input${main ? ' id="murl"' : ""} class="js-murl" value="${esc(manifestUrl)}" readonly translate="no" aria-label="Addon link"><button type="button" class="btn js-copy" data-label="Copy link" aria-live="polite">Copy link</button></div>`;
  const heroHtml = home ? `<section class="hero">
  <div>
    <h1>New on OTT,<br>all in Telugu.${ast}</h1>
    <p class="lead">Free catalogs of the newest Telugu movies and series, plus titles dubbed in Telugu. Updated every morning.</p>
  </div>
  <div class="get">
    <div class="ctas">
      <a class="btn primary lg js-install" href="${esc(appInstall)}">${plus}Install</a>
      <button type="button" class="btn lg" id="cfgbtn" aria-expanded="false" aria-controls="cfg">${icon("M3 5h6M12 5h1M3 11h1M7 11h6M10.5 3.5v3M5.5 9.5v3")}Configure</button>
    </div>
    ${linkBox(true)}
  </div>
</section>` : `<h1 class="cfgh1">Set up TFI Movies</h1>`;
  const cfgHtml = `<section class="cfg" id="cfg"${home ? " hidden" : ""} aria-labelledby="cfgh">
  <div>
    <h2 id="cfgh">Choose your catalogs</h2>
    <div class="chips" id="presets" role="group" aria-label="Quick choices">${Object.entries(presets).map(([p, [label, list]]) => `<button type="button" data-p="${p}" aria-pressed="${sameSet(list, keys)}"${sameSet(list, keys) ? ' class="on"' : ""}>${label}</button>`).join("")}</div>
    <ul id="clist"></ul>
    <button type="button" class="link" id="resetorder">Reset</button>
  </div>
  <div class="get">
    <p class="csum"><b class="js-sum">All ${ALL_KEYS.length} catalogs</b></p>
    <a class="btn primary lg wide js-install" href="${esc(appInstall)}">${plus}Install</a>
    ${linkBox(!home)}
  </div>
</section>`;
  // Posters come from this site's own /poster/ address, never straight from TMDB. A poster that fails to load is
  // removed, which leaves the film's name showing on its plain card.
  const boardHtml = board.length ? `<section class="board" aria-labelledby="nowh">
  <div class="bhead"><h2 id="nowh">Newest in Telugu</h2><p>Refreshed every morning.</p></div>
  <ul class="bill">${board.map((t, i) => `<li><span class="fr"><i aria-hidden="true">${esc(t.name)}</i>${t.poster ? `<img src="/poster/${esc(t.poster)}" width="185" height="278" alt="" decoding="async" ${i < 3 ? 'fetchpriority="high"' : 'loading="lazy"'} onerror="this.remove()">` : ""}</span><b>${esc(t.name)}</b><small><span>${esc(t.genres[0] || "")}${t.genres[1] ? `<span class="g2">, ${esc(t.genres[1])}</span>` : ""}</span>${t.rating ? `<span class="rt"><span aria-hidden="true">★</span><span class="vh">Rated</span> ${esc(t.rating)}</span>` : ""}</small></li>`).join("")}</ul>
</section>` : "";
  // A collection cover: a still picture that plays its GIF (what Nuvio shows while the tile has focus).
  const tile = (d, auto) => `<button type="button" class="tile${auto ? " big" : ""}" data-still="/art/${esc(d.key)}/cover.webp" data-gif="/art/${esc(d.key)}/focus.gif"${auto ? " data-auto" : ""} data-name="${esc(d.name)}" aria-label="Play the ${esc(d.name)} cover"><img src="/art/${esc(d.key)}/cover.webp" width="480" height="270" loading="lazy" alt=""></button>`;
  const nuvioHtml = home ? `<section class="nv" id="nuvio" aria-labelledby="nvh">
  <div>
    <h2 id="nvh">Add collections to your Nuvio account</h2>
    <p class="d">Sign in once: the TFI Movies collection and its catalogs go on all your devices. Your own collections stay as they are.</p>
    <div class="pv">${tile(ALL_DEFS[0], true)}
      <div class="thumbs">${ALL_DEFS.slice(1, 4).map((d) => tile(d, false)).join("")}</div>
      <p>A TFI Movies row on Nuvio's Home, with a cover for each catalog. Tap a cover to play or stop it.</p></div>
  </div>
  <div class="acct" id="acct">
    <div id="acctin">
      <form id="acctform" class="stack" onsubmit="return false">
        <div class="field"><label for="nemail">Nuvio email</label><input type="email" id="nemail" autocomplete="username" spellcheck="false" autocapitalize="none" placeholder="name@example.com" required></div>
        <div class="field"><label for="npass">Nuvio password</label><div class="pw"><input type="password" id="npass" autocomplete="current-password" aria-describedby="smsg" required><button type="button" class="eye" id="neye" aria-label="Show password" aria-pressed="false">${icon("M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z")}</button></div></div>
        <button type="submit" class="btn primary" id="nsignin">Sign in to Nuvio</button>
      </form>
      <p class="nmsg" id="smsg" role="status"></p>
      <details class="how"><summary>🔒 Sent only to Nuvio (api.nuvio.tv). Never stored. <span>How?</span></summary>
        <p>This box talks to Nuvio straight from your browser, through <a href="https://nuvio.tv/docs/server-api" target="_blank" rel="noopener">Nuvio's public API</a>. Your password goes to Nuvio's server only, never to TFI Movies, and nothing is saved in this browser. Closing the page signs you out. <a href="${REPO_URL}/blob/main/api/index.js" target="_blank" rel="noopener">The code for this box is public</a>.</p></details>
    </div>
    <div id="acctready" hidden>
      <p class="d" id="nhint">Tap a profile to add it.</p>
      <div class="profiles" id="nprofiles"></div>
      <div id="nallrow"><button type="button" class="btn" id="nall">Add to all profiles</button></div>
      <p class="locknote" id="nlocknote" hidden></p>
      <div class="done" id="ndone" hidden><div class="tick" aria-hidden="true">✓</div><div><b id="ndonetitle"></b><ol id="ndonesteps"><li>Close Nuvio fully.</li><li>Open it again: TFI Movies is on Home.</li></ol><p class="d" id="ndonenote"></p></div></div>
      <p class="nmsg" id="amsg" role="status"></p>
      <p class="who">Signed in as <span id="nwho"></span> · <button type="button" class="link" id="nsignout">Sign out</button></p>
    </div>
    <details class="other"><summary>Other ways to add collections</summary><div class="in">
      <p>These add the collection only. Install the catalogs with the Install button at the top of this page.</p>
      <h3>On a Nuvio TV</h3>
      <p><b>Addons → Collections → Import → From URL</b>: <code translate="no">${esc(base)}/nuvio-collections.json</code></p>
      <h3>On a phone, without signing in</h3>
      <ol class="flow">
        <li><span>In Nuvio, <b>Settings → Layout → Collections</b>, tap the <b>Copy</b> icon.</span></li>
        <li><span>Tap Add TFI Movies: it adds TFI to what you copied and copies it back.</span>
          <div class="act"><button type="button" class="btn primary" id="addtfi">Add TFI Movies</button><button type="button" class="btn primary" id="copyresult" hidden>Copy result</button></div>
          <p class="nmsg" id="nmsg" role="status" style="grid-column:2"></p></li>
        <li><span>In Nuvio tap the <b>Paste</b> icon, paste and tap <b>Import</b>.</span></li>
      </ol>
      <p style="margin-top:12px">No collections in Nuvio yet? <button type="button" class="link" id="copytfi">Copy the TFI collection</button> and paste it in step 3.</p>
      <details id="manual"><summary>Step 2 can't read what you copied?</summary>
        <div class="combine"><textarea id="mine" rows="3" spellcheck="false" autocomplete="off" placeholder="Paste what Nuvio's Copy icon copied" aria-label="Your Nuvio collections"></textarea>
        <button type="button" class="btn" id="combine">Add TFI Movies and copy</button></div></details>
    </div></details>
  </div>
</section>` : "";
  // For people who want the lists without the addon: the same eight lists, public on TMDB.
  const listed = home && data.lists ? ALL_DEFS.filter((d) => data.lists[d.key]) : [];
  const listLinks = (media) => listed.filter((d) => d.media === media).map((d) => `<li><a href="https://www.themoviedb.org/list/${encodeURIComponent(data.lists[d.key])}" target="_blank" rel="noopener">${esc(d.name)}</a></li>`).join("");
  const listsHtml = listed.length ? `<section class="lists" id="lists" aria-labelledby="listsh">
  <h2 id="listsh">Just want the lists?</h2>
  <p>The same lists are public on TMDB, refreshed every morning. You don't need the addon to use them.</p>
  <div class="lcols">
    ${listLinks("movie") ? `<div><h3>Movies</h3><ul>${listLinks("movie")}</ul></div>` : ""}
    ${listLinks("tv") ? `<div><h3>Series</h3><ul>${listLinks("tv")}</ul></div>` : ""}
  </div>
</section>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TFI Movies · Stremio addon: new movies and series in Telugu</title>
<meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#0c0914">
<meta property="og:title" content="TFI Movies"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(base)}/tfi-logo.png"><meta property="og:url" content="${esc(base)}/">
<link rel="icon" type="image/png" href="/tfi-logo.png">
<link rel="preload" href="/fonts/outfit-bold.ttf" as="font" type="font/ttf" crossorigin>
<style>
@font-face{font-family:"Outfit";src:url(/fonts/outfit-bold.ttf) format("truetype");font-weight:700;font-display:swap}
:root{--bg:#0c0914;--panel:#15101f;--panel2:#1e172c;--line:#2a2140;--line2:#40345c;--fg:#f4f0fb;--mut:#aca3c2;--dim:#8f86a8;
  --acc:#a855f7;--acc2:#d4b0ff;--lit:#f3e9ff;--ink:#1b0c33;--ok:#4ade80;--no:#f87171;--maybe:#fbbf24;
  --head:"Outfit",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:16px;background:var(--bg);-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:rgba(168,85,247,.25)}
a,button,input,label,summary{touch-action:manipulation}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--acc2);text-underline-offset:3px}
[hidden]{display:none!important}
:focus-visible{outline:2px solid var(--acc2);outline-offset:2px}
h1,h2,.brand{font-family:var(--head);font-weight:700}
h1,h2{text-wrap:balance}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.skip{position:absolute;left:-9999px;top:12px;z-index:30;background:var(--lit);color:var(--ink);padding:8px 12px;border-radius:8px;font-weight:600}
.skip:focus{left:16px}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.top .wrap{display:flex;align-items:center;gap:24px;height:64px}
.brand{display:flex;align-items:center;gap:10px;font-size:18px;color:var(--fg);text-decoration:none;white-space:nowrap}
.brand img{width:32px;height:32px;border-radius:8px}
nav{display:flex;align-items:center;gap:4px;margin-left:auto}
nav a{color:var(--mut);text-decoration:none;font-size:14px;padding:8px 12px;border-radius:8px;white-space:nowrap}
nav a:hover{color:var(--fg);background:var(--panel2)}
nav a.gh{border:1px solid var(--line2)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 18px;border-radius:10px;font-family:inherit;font-size:15px;font-weight:600;line-height:1.2;
  text-decoration:none;color:var(--fg);border:1px solid var(--line2);background:var(--panel2);cursor:pointer;white-space:nowrap;touch-action:manipulation;transition:background-color .15s,border-color .15s,box-shadow .15s}
.btn:hover{background:#2a2040;border-color:#5b4b82}
.btn:disabled{opacity:.45;cursor:default}
.btn.primary{background:var(--lit);border-color:var(--lit);color:var(--ink)}
.btn.primary:hover{background:#fff;border-color:#fff}
.btn.lg{padding:15px 22px;font-size:16px;border-radius:12px;border-color:var(--acc);background:transparent}
.btn.lg:hover,.btn.lg[aria-expanded=true]{background:var(--panel2);border-color:var(--acc2)}
/* the lit sign, like the logo's tube lettering: Install only */
.btn.primary.lg{background:var(--lit);border-color:var(--lit);box-shadow:0 0 0 1px rgba(216,180,254,.9),0 0 18px rgba(168,85,247,.8),0 0 46px rgba(168,85,247,.35)}
.btn.primary.lg:hover{background:#fff;border-color:#fff;box-shadow:0 0 0 1px #e9d5ff,0 0 22px rgba(168,85,247,.95),0 0 58px rgba(168,85,247,.45)}
.btn.wide{width:100%}
.btn svg{width:18px;height:18px;flex:none}
.link{font:inherit;font-size:13px;color:var(--mut);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.link:hover{color:var(--fg)}
.link:disabled{visibility:hidden}
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,400px);gap:26px 56px;align-items:end;padding:44px 0 40px}
h1{font-size:clamp(40px,6.6vw,76px);line-height:1;letter-spacing:-.02em;margin:0 0 18px}
h1.cfgh1{font-size:clamp(26px,4vw,34px);margin:20px 0 18px}
.lead{color:var(--mut);font-size:18px;margin:0;max-width:32em}
sup{line-height:0}
h1 sup{font-size:.5em;vertical-align:baseline;position:relative;top:-.72em}
.ast{color:var(--acc2);text-decoration:none;padding:0 2px}
.ast:hover{color:#fff}
.ctas{display:flex;gap:14px}
.ctas .btn{flex:1 1 0;min-width:0}
.hint{margin:14px 2px 8px;color:var(--mut);font-size:14px;line-height:1.45}
.hint.on{color:var(--fg)}
.copy{display:flex;border:1px solid var(--line2);border-radius:10px;background:var(--bg)}
.copy input{flex:1;min-width:0;background:transparent;border:0;border-radius:10px 0 0 10px;color:var(--mut);padding:10px 12px;font:12px ui-monospace,Consolas,monospace}
.copy .btn{border:0;border-left:1px solid var(--line2);border-radius:0 9px 9px 0;font-size:13px;padding:8px 14px}
.none .js-install,.none .js-copy{opacity:.4;pointer-events:none}
/* Configure: the catalogs to pick and put in order, with their own Install and link */
.cfg{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,400px);gap:24px 56px;align-items:start;margin:0 0 44px;padding:22px 24px 24px;border:1px solid var(--line2);border-radius:16px;background:var(--panel)}
.cfg h2{font-size:22px;line-height:1.2;letter-spacing:-.01em;margin:0 0 14px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.chips button{font:inherit;font-size:13px;font-weight:500;color:var(--mut);background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:7px 13px;cursor:pointer;touch-action:manipulation}
.chips button:hover{color:var(--fg)}
.chips button.on{color:var(--fg);background:rgba(168,85,247,.2);border-color:var(--acc)}
.csum{font-size:15px;color:var(--mut);margin:0 0 12px}
.csum b{color:var(--fg)}
#clist{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:4px}
#clist li{display:flex;align-items:center;gap:10px;padding:7px 7px 7px 9px;border:1px solid var(--line);background:var(--panel2);border-radius:10px;font-size:14px}
#clist li.off{opacity:.55}
#clist .oname{flex:1;min-width:0;line-height:1.25}
#clist small{display:block;color:var(--dim);font-size:11px}
#clist button{width:30px;height:30px;flex:none;display:grid;place-items:center;border:1px solid var(--line2);background:transparent;color:var(--mut);border-radius:8px;cursor:pointer;padding:0;touch-action:manipulation}
#clist button:hover:not(:disabled){color:var(--fg);border-color:var(--acc)}
#clist button:disabled{opacity:.25;cursor:default}
#clist button svg{width:14px;height:14px}
.pick{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}
.sw{position:relative;width:38px;height:22px;flex:none}
.sw input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1}
.sw i{position:absolute;inset:0;border-radius:999px;background:var(--line2);transition:background-color .2s}
.sw i::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:transform .2s}
.sw input:checked+i{background:var(--acc)}
.sw input:checked+i::after{transform:translateX(16px)}
.sw input:focus-visible+i{outline:2px solid var(--acc2);outline-offset:2px}
/* the board: a row of poster cases under one tube light */
.board{position:relative;padding:34px 0 8px}
.board::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;border-radius:3px;background:var(--lit);
  box-shadow:0 0 6px 1px #e3c9ff,0 0 22px 3px rgba(168,85,247,.85),0 0 70px 8px rgba(168,85,247,.38)}
.board::after{content:"";position:absolute;left:0;right:0;top:3px;height:200px;pointer-events:none;background:radial-gradient(ellipse 62% 100% at 50% 0,rgba(168,85,247,.17),transparent 72%)}
.board>*{position:relative;z-index:1}
.bhead{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:4px 24px;margin:0 0 22px}
.bhead h2{font-size:clamp(22px,3vw,30px);line-height:1.15;letter-spacing:-.01em;margin:0}
.bhead p{margin:0;color:var(--mut);font-size:14px}
.bill{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:28px 18px}
.bill li{min-width:0}
.fr{position:relative;display:grid;place-items:center;aspect-ratio:2/3;background:var(--panel);border:1px solid var(--line);border-radius:5px;overflow:hidden}
.fr i{font-style:normal;font-family:var(--head);font-weight:700;font-size:15px;line-height:1.25;text-align:center;padding:10px;color:var(--mut);overflow-wrap:anywhere}
.fr img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.bill b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:10px 0 2px;font-size:14px;line-height:1.3;font-weight:600;overflow-wrap:anywhere}
.bill small{display:flex;justify-content:space-between;gap:8px;color:var(--dim);font-size:13px}
.bill small>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bill .rt{flex:none;color:var(--mut);font-variant-numeric:tabular-nums}
/* Nuvio collections: what you get on the left, the sign-in on the right */
.nv{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,440px);gap:32px 56px;align-items:start;padding:76px 0 24px}
.nv>*{min-width:0}
.nv h2{font-size:clamp(26px,3.4vw,38px);line-height:1.08;letter-spacing:-.015em;margin:0 0 12px}
.nv .d{color:var(--mut);margin:0 0 22px;max-width:31em}
.pv p{margin:10px 0 0;color:var(--dim);font-size:13px}
.tile{display:block;width:100%;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--panel2);overflow:hidden;cursor:pointer;touch-action:manipulation}
.tile:hover{border-color:var(--acc)}
.tile img{display:block;width:100%;height:auto;aspect-ratio:16/9}
.tile.big{border-radius:12px}
.thumbs{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0 0}
.acct{border:1px solid var(--line2);border-radius:16px;background:var(--panel);padding:22px}
.acct .d{color:var(--mut);font-size:14px;margin:0 0 14px}
.acct details{margin:0}
.acct summary{display:inline-flex;font-weight:500;font-size:14px;color:var(--mut);padding:2px 0;gap:6px}
.acct summary::after{content:"▾";font-size:12px;transition:transform .2s}
.acct details[open]>summary::after{transform:rotate(180deg)}
.acct summary:hover{color:var(--fg)}
.other{margin:18px 0 0!important}
.other .in{padding:10px 0 0;color:var(--mut);font-size:14px}
.other .in p{margin:0 0 12px}
.other .in b{color:var(--fg)}
.other code{word-break:break-all;overflow-wrap:anywhere;color:var(--mut);font-size:12px}
.other h3{margin:14px 0 6px;font-size:14px;color:var(--fg)}
.flow{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:8px;counter-reset:f}
.flow>li{counter-increment:f;display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start}
.flow>li::before{content:counter(f);width:24px;height:24px;border-radius:7px;display:grid;place-items:center;background:var(--panel2);color:var(--fg);font-size:12px;font-weight:700}
.flow .act{grid-column:2;display:flex;gap:8px;flex-wrap:wrap}
.flow .act .btn{font-size:13px;padding:7px 12px}
.nmsg{font-size:14px;margin:6px 0 0;color:var(--mut)}
.nmsg:empty{display:none}
.nmsg.ok{color:var(--ok)}.nmsg.err{color:var(--no)}
.combine textarea{display:block;width:100%;min-height:80px;resize:vertical;background:var(--bg);border:1px solid var(--line2);border-radius:10px;color:var(--fg);padding:8px 10px;font:12px/1.5 ui-monospace,Consolas,monospace}
.combine .btn{margin:8px 0 0}
.acct .stack{display:grid;gap:12px}
.acct .field{display:grid;gap:5px}
.acct .field label{font-size:13px;font-weight:600;color:var(--mut)}
.acct input[type=email],.acct input[type=password],.acct input[type=text]{width:100%;min-width:0;background:var(--bg);border:1px solid var(--line2);border-radius:10px;color:var(--fg);padding:11px 12px;font:inherit;font-size:16px}
.acct .pw{position:relative}
.acct .pw input{padding-right:46px}
.acct .eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:38px;height:38px;background:none;border:0;border-radius:8px;color:var(--dim);cursor:pointer}
.acct .eye:hover,.acct .eye[aria-pressed=true]{color:var(--fg)}
.acct .eye svg{width:18px;height:18px}
.acct .how{margin:10px 0 0}
.acct .how summary{display:block;font-weight:400;font-size:13px;color:var(--mut)}
.acct .how summary::after{content:none}
.acct .how summary span{text-decoration:underline;text-underline-offset:3px}
.acct .how p{margin:8px 0 0;color:var(--dim);font-size:13px}
.acct .how a{color:var(--mut)}
.profiles{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}
.prof{display:grid;justify-items:center;align-content:start;gap:5px;width:84px;padding:8px 2px;background:none;border:1px solid transparent;border-radius:14px;color:var(--fg);font:inherit;cursor:pointer;touch-action:manipulation}
.prof:hover:not(:disabled){background:var(--panel2);border-color:var(--line2)}
.prof:disabled{cursor:default}
.prof.locked{opacity:.45}
.prof .av{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;font-size:21px;font-weight:700;color:#fff;background:#7c3aed;text-shadow:0 1px 2px rgba(0,0,0,.35)}
.prof .pn{font-size:13px;max-width:78px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prof .badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:99px;background:rgba(52,211,153,.15);color:var(--ok)}
.prof .badge.lk{background:var(--panel2);color:var(--mut)}
.prof.busy .av{animation:avpulse 1s ease-in-out infinite}
@keyframes avpulse{50%{opacity:.45}}
.acct .locknote{color:var(--mut);font-size:13px;margin:10px 0 0}
.acct .done{display:flex;gap:12px;align-items:flex-start;margin:14px 0 0;padding:12px 14px;border-radius:12px;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.3)}
.acct .done .tick{flex:none;width:32px;height:32px;border-radius:50%;background:var(--ok);color:var(--bg);display:grid;place-items:center;font-size:17px;font-weight:800}
.acct .done b{display:block;font-size:15px;color:var(--fg)}
.acct .done ol{margin:4px 0 0;padding-left:18px;color:var(--fg);font-size:14px}
.acct .done .d{margin:6px 0 0}
.acct .who{color:var(--dim);font-size:13px;margin:12px 0 0}
.lists{max-width:760px;padding:64px 0 0}
.lists h2{font-size:clamp(24px,3vw,30px);margin:0 0 8px;letter-spacing:-.01em}
.lists p{color:var(--mut);margin:0 0 18px}
.lcols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 40px}
.lists h3{margin:0 0 6px;font-size:14px;color:var(--dim);font-weight:600}
.lists ul{list-style:none;margin:0;padding:0}
.lists li{border-bottom:1px solid var(--line)}
.lists li a{display:block;padding:11px 0;color:var(--fg);text-decoration:none;font-weight:600}
.lists li a:hover{color:var(--acc2)}
.faq{max-width:760px;padding:64px 0 24px}
.faq h2{font-size:clamp(24px,3vw,30px);margin:0 0 8px;letter-spacing:-.01em}
.faq details{border-bottom:1px solid var(--line)}
.faq summary{cursor:pointer;font-weight:600;padding:16px 0;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px}
summary::-webkit-details-marker{display:none}
summary{list-style:none;cursor:pointer}
.faq summary::after{content:"+";color:var(--mut);font-size:22px;font-weight:400;line-height:1;transition:transform .2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq summary:hover{color:var(--acc2)}
.faq details p,.faq details ul{color:var(--mut);margin:0 0 16px}
.faq details ul{padding-left:20px}
.faq details li{margin:4px 0}
.faq b{color:var(--fg)}
footer{border-top:1px solid var(--line);margin-top:24px;padding:22px 0 40px;color:var(--dim);font-size:13px}
footer p{margin:4px 0}
footer .fl{display:flex;flex-wrap:wrap;gap:2px 18px}
footer a{color:var(--mut)}
@media (max-width:900px){
  .hero{grid-template-columns:minmax(0,1fr);gap:22px;padding:18px 0 30px}
  .lead{font-size:16px}
  .bill{gap:24px 12px}.bill .g2{display:none}
  .cfg{grid-template-columns:minmax(0,1fr);margin-bottom:34px}
  .nv{grid-template-columns:minmax(0,1fr);padding-top:56px}
}
@media (max-width:560px){.lcols{grid-template-columns:minmax(0,1fr)}.wrap{padding:0 16px}.top .wrap{height:56px;gap:10px}nav a{font-size:13px;padding:7px 8px}nav a.gh{display:none}
  .bill{grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 10px}.bill .g2{display:none}.cfg{padding:16px}.acct{padding:16px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}html{scroll-behavior:auto}}
</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap">
  <a class="brand" href="/" translate="no"><img src="/tfi-logo.png" alt="" width="32" height="32">TFI Movies</a>
  <nav><a href="${home ? "" : "/"}#nuvio">Nuvio collections</a><a href="#faq">FAQ</a><a class="gh" href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></nav>
</div></header>

<main class="wrap" id="main">
${heroHtml}
${cfgHtml}
${boardHtml}
${nuvioHtml}
${listsHtml}

<section id="faq" class="faq">
  <h2>Questions</h2>
  <details id="note"><summary>Does every title have Telugu audio?</summary>
    <p>Most probably, but it isn't guaranteed. Telugu films and series are in automatically. Each dubbed title is checked every day:</p>
    <ul><li><b>In:</b> JustWatch or Netflix lists Telugu audio, it's on ETV Win, or OTT release news (Sacnilk, 123telugu) says so.</li>
      <li><b>Kept, unconfirmed:</b> JustWatch knows the title but no service lists its audio languages yet (mostly Sun NXT).</li>
      <li><b>Left out:</b> the audio languages are listed and Telugu isn't one, or nothing confirms it.</li></ul>
    <p>TFI Movies only lists titles and has no streams, so whether you get the Telugu track depends on your stream addons and their settings. Found one without Telugu? <a href="${REPO_URL}/issues" target="_blank" rel="noopener">Tell us on GitHub</a>.</p></details>
  <details><summary>Install does nothing. What now?</summary><p>The Install button needs an app that takes Stremio addons on this device, such as Stremio or Nuvio. Install one first, then tap Install again. Or copy the addon link at the top of this page and add it in your app's Addons section: that also works for Stremio in a web browser.</p></details>
  <details><summary>Does TFI Movies play videos?</summary><p>No. It adds catalogs: posters, details, ratings and trailers for what's new on Indian OTT. It doesn't host or link to any video.</p></details>
  <details><summary>How fresh are the catalogs?</summary><p>They update every morning (India time) from TMDB's streaming data, plus OTT release news from Sacnilk, 123telugu and 91mobiles.</p></details>
  <details><summary>What are collections in Nuvio?</summary><p>A "TFI Movies" row on Nuvio's Home with a cover for each catalog. Each cover is made from the newest titles in its list and changes when the list does. It needs the catalogs installed and adds no titles of its own.</p></details>
  <details><summary>Can I change my catalogs later?</summary><p>Yes. Press <b>Configure</b>, here or on TFI Movies in Stremio, change your choice and install again.</p></details>
  <details><summary>Is it free? Was it made with AI?</summary><p>It's free, needs no account and is <a href="${REPO_URL}" target="_blank" rel="noopener">open source</a>. It was built with the help of AI, and the catalogs are made automatically every day with no person checking each title, so details, including Telugu audio, can be wrong.</p></details>
</section>
</main>

<footer><div class="wrap">
  <p class="fl"><span>TFI Movies v${esc(manifest(base).version)}</span><a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a><span>Built with AI help; details can be wrong.</span></p>
  <p>Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a>. This product uses the TMDB API but is not endorsed or certified by TMDB. Not affiliated with Stremio, Nuvio or any streaming service.</p>
</div></footer>

<script>
(function () {
var KEYS = ${js(ALL_KEYS)}, NAMES = ${js(names)}, PRESETS = ${js(Object.fromEntries(Object.entries(presets).map(([p, v]) => [p, v[1]])))};
var BASE = ${js(base)}, HOST = ${js(host)}, UP = ${js(icon("M4 10l4-4 4 4"))}, DOWN = ${js(icon("M4 6l4 4 4-4"))};
var order = ${js(keys)};
var $ = function (s) { return document.querySelector(s); };
var all = function (s) { return [].slice.call(document.querySelectorAll(s)); };
var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
var sameSet = function (a, b) { return a.length === b.length && a.every(function (k) { return b.indexOf(k) >= 0; }); };

// ---- Install: one stremio:// link, which every app that takes Stremio addons opens (the phone or computer asks
// which one). After a tap, the line above the addon link says what to do when nothing opened. ----
all(".js-install").forEach(function (a) {
  a.addEventListener("click", function () {
    var h = a.closest(".get").querySelector(".hint"); // only the line beside this button, so it is announced once
    h.textContent = "Not working? Copy the link below and add it in your app's Addons section."; h.classList.add("on");
  });
});

// ---- Configure: quick choices, and one list to switch catalogs on or off and set their order ----
var cfgBox = $("#cfg"), cfgBtn = $("#cfgbtn"); // no button on a /configure page: the list is already open there
function openCfg(open) { cfgBox.hidden = !open; if (cfgBtn) cfgBtn.setAttribute("aria-expanded", open ? "true" : "false"); }
if (cfgBtn) cfgBtn.addEventListener("click", function () { openCfg(cfgBox.hidden); });
function moveBtn(k, d, label, off) {
  return '<button type="button" data-k="' + k + '" data-d="' + d + '" aria-label="Move ' + esc(NAMES[k][0]) + " " + label + '"' + (off ? " disabled" : "") + ">" + (d < 0 ? UP : DOWN) + "</button>";
}
function row(k, i) {
  var on = i >= 0;
  return '<li class="' + (on ? "on" : "off") + '"><label class="pick"><span class="sw"><input type="checkbox" value="' + k + '"' + (on ? " checked" : "") + ' aria-label="' + esc(NAMES[k][0]) + '"><i></i></span>'
    + '<span class="oname">' + esc(NAMES[k][0]) + "<small>" + NAMES[k][1] + "</small></span></label>"
    + (on ? moveBtn(k, -1, "up", i === 0) + moveBtn(k, 1, "down", i === order.length - 1) : "") + "</li>";
}
function render() {
  var cfg = order.join(",") === KEYS.join(",") ? "" : "/" + order.join(",");
  var m = BASE + cfg + "/manifest.json";
  all(".js-murl").forEach(function (i) { i.value = m; });
  all(".js-install").forEach(function (a) { a.href = "stremio://" + HOST + cfg + "/manifest.json"; });
  var sum = !order.length ? "No catalogs" : order.length === KEYS.length ? "All " + KEYS.length + " catalogs" : order.length + " of " + KEYS.length + " catalogs";
  all(".js-sum").forEach(function (e) { e.textContent = sum; });
  all("#presets button").forEach(function (b) { var on = sameSet(PRESETS[b.getAttribute("data-p")], order); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  $("#clist").innerHTML = order.map(row).join("") + KEYS.filter(function (k) { return order.indexOf(k) < 0; }).map(function (k) { return row(k, -1); }).join("");
  $("#resetorder").disabled = order.join(",") === KEYS.join(",");
  document.body.classList.toggle("none", !order.length);
}
$("#clist").addEventListener("change", function (e) {
  var k = e.target.value, i = order.indexOf(k);
  if (!k) return;
  if (e.target.checked && i < 0) order.push(k);
  if (!e.target.checked && i >= 0) order.splice(i, 1);
  render();
});
$("#presets").addEventListener("click", function (e) { // a quick choice; tapping the one that's on goes back to all
  var b = e.target.closest("button[data-p]");
  if (!b) return;
  var set = PRESETS[b.getAttribute("data-p")];
  order = sameSet(set, order) ? KEYS.slice() : set.slice();
  render();
});
$("#clist").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-d]");
  if (!b) return;
  var k = b.getAttribute("data-k"), d = b.getAttribute("data-d"), i = order.indexOf(k), j = i + Number(d);
  if (i < 0 || j < 0 || j >= order.length) return;
  order.splice(j, 0, order.splice(i, 1)[0]);
  render();
  var next = document.querySelector('#clist button[data-k="' + k + '"][data-d="' + d + '"]:not(:disabled)') || document.querySelector('#clist button[data-k="' + k + '"]:not(:disabled)');
  if (next) next.focus();
});
$("#resetorder").addEventListener("click", function () { order = KEYS.slice(); render(); }); // all catalogs, in the usual order

// ---- collection covers: the first plays by itself once it is on screen (not when the visitor asked for less motion
// or less data); every cover plays on hover with a mouse, or on a tap ----
var quiet = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) || !!(navigator.connection && navigator.connection.saveData);
function play(t, on) {
  t.querySelector("img").src = t.getAttribute(on ? "data-gif" : "data-still");
  if (on) t.setAttribute("data-on", ""); else t.removeAttribute("data-on");
  t.setAttribute("aria-label", (on ? "Stop the " : "Play the ") + t.getAttribute("data-name") + " cover");
}
all(".tile").forEach(function (t) {
  t.addEventListener("click", function () { play(t, !t.hasAttribute("data-on")); });
  if (t.hasAttribute("data-auto")) return;
  t.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse") play(t, true); });
  t.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") play(t, false); });
});
all(".tile[data-auto]").forEach(function (t) {
  if (quiet || !("IntersectionObserver" in window)) return;
  var io = new IntersectionObserver(function (es) {
    if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); play(t, true); }
  }, { rootMargin: "100px" });
  io.observe(t);
});

render();
// an older link: /#customize opens Configure (/#nuvio is the Nuvio section's own address now)
var HASH = typeof location !== "undefined" ? location.hash : "";
if (HASH === "#customize") { openCfg(true); try { cfgBox.scrollIntoView({ behavior: "instant" }); } catch (e) { cfgBox.scrollIntoView(); } }
all(".js-copy").forEach(function (b) { b.addEventListener("click", function () { copyButton(b, function () { return $("#murl").value; }); }); });
if (!$("#acct")) return; // a /configure page has no Nuvio section: nothing below applies there
// Nuvio's phone app imports only by pasting, and an import replaces all collections: so the TFI collection is
// added to the user's own (what Nuvio's Copy icon gives), replacing an earlier copy of it, and that is copied back.
var TFI = ${js(nuvioCollection(base))};
function copyText(text, ok, fail) {
  var fallback = function () {
    var t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    var done = false; try { done = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(t);
    if (done) ok(); else fail();
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
}
function say(text, kind) { var m = $("#nmsg"); m.textContent = text; m.className = "nmsg" + (kind ? " " + kind : ""); }
var tfiIds = TFI.map(function (c) { return c.id; });
function assign(to, from) { for (var k in from) if (Object.prototype.hasOwnProperty.call(from, k)) to[k] = from[k]; return to; }
// A TFI collection the user already has is updated where it sits, keeping what they set on it: its pin, and their
// per-folder switches (e.g. the phone's GIF toggle). Only the fields this site writes are replaced.
function updateTfi(old, site) {
  var c = assign(assign({}, old), site);
  if (typeof old.pinToTop === "boolean") c.pinToTop = old.pinToTop;
  c.folders = site.folders.map(function (f) {
    var was = (old.folders || []).filter(function (o) { return o && o.id === f.id; })[0];
    return assign(assign({}, was || {}), f);
  });
  return c;
}
// The user's collections (Nuvio's Copy output) with TFI Movies updated in place or added at the end, or null when
// the text isn't that.
function addTfi(raw) {
  var mine;
  try { mine = JSON.parse(String(raw || "").replace(/^\\uFEFF/, "").trim()); } catch (e) { return null; }
  if (!Array.isArray(mine)) return null;
  var out = mine.map(function (c) { var i = c ? tfiIds.indexOf(c.id) : -1; return i < 0 ? c : updateTfi(c, TFI[i]); });
  var have = mine.map(function (c) { return c && c.id; });
  TFI.forEach(function (t) { if (have.indexOf(t.id) < 0) out.push(assign(assign({}, t), { pinToTop: true })); }); // new: pinned, shows first on Home
  var count = mine.filter(function (c) { return c && tfiIds.indexOf(c.id) < 0; }).length;
  return { text: JSON.stringify(out), count: count };
}
var copied = function (r) { return "Copied: your " + r.count + " collection" + (r.count === 1 ? "" : "s") + " plus TFI Movies. Now paste it in Nuvio (step 3)."; };
var pending = null; // a result that couldn't be copied without another tap
function manual(why) {
  $("#manual").open = true;
  say(why + " Paste it in the box below instead.", "err");
  $("#mine").focus();
}
// Step 3, one tap: read what Nuvio's Copy icon put on the clipboard, add TFI Movies, put the result back.
$("#addtfi").addEventListener("click", function () {
  $("#copyresult").hidden = true;
  if (!(navigator.clipboard && navigator.clipboard.readText && window.isSecureContext)) return manual("This browser can't read what you copied.");
  navigator.clipboard.readText().then(function (raw) {
    if (!String(raw || "").trim()) return say("Nothing copied yet: in Nuvio tap the Copy icon first (step 1).", "err");
    var r = addTfi(raw);
    if (!r) return say("What you copied isn't Nuvio's collections. In Nuvio tap the Copy icon again (step 1), then come back and tap Add TFI Movies.", "err");
    copyText(r.text, function () { say(copied(r), "ok"); }, function () {
      pending = r; // the browser wants a fresh tap before it lets the page copy
      $("#copyresult").hidden = false;
      say("Ready: tap Copy result.", "ok");
    });
  }, function () { manual("The browser didn't let the page read what you copied."); });
});
$("#copyresult").addEventListener("click", function () {
  if (!pending) return;
  var r = pending;
  copyText(r.text, function () { pending = null; $("#copyresult").hidden = true; say(copied(r), "ok"); }, function () {
    $("#manual").open = true; $("#mine").value = r.text; $("#mine").select();
    say("Couldn't copy. The result is in the box below: copy it from there.", "err");
  });
});
$("#combine").addEventListener("click", function () {
  var raw = $("#mine").value;
  if (!raw.trim()) return say("Paste your collections from Nuvio in the box first.", "err");
  var r = addTfi(raw);
  if (!r) return say("That isn't what Nuvio's Copy icon gives. In Nuvio tap Copy again and paste the whole text here.", "err");
  copyText(r.text, function () { say(copied(r), "ok"); }, function () {
    $("#mine").value = r.text; $("#mine").select();
    say("Couldn't copy by itself. The result is in the box now: copy it from there.", "err");
  });
});
$("#copytfi").addEventListener("click", function () {
  copyText(JSON.stringify(TFI), function () {
    say("Copied the TFI collection. Now paste it in Nuvio (step 3). It replaces any collections you have there.", "ok");
  }, function () { say("Couldn't copy. Open " + BASE + "/nuvio-collections.json and copy everything there.", "err"); });
});
function copyButton(b, value) {
  var label = b.getAttribute("data-label");
  copyText(value(), function () { b.textContent = "Copied!"; setTimeout(function () { b.textContent = label; }, 1600); }, function () { b.textContent = "Couldn't copy"; });
}

// ---- Add TFI Movies to a Nuvio account, through Nuvio's documented public API (nuvio.tv/docs/server-api) ----
// Runs only in this browser: the password and the session go straight to api.nuvio.tv and are kept in memory only.
// Collections are one list per profile that a push replaces whole, so the list is read first, TFI is added (pinned)
// or updated in place (addTfi), and it's read back to check. The TFI catalogs are installed when a profile lacks them.
// Nuvio's API can't check a profile PIN, so PIN-locked profiles are never changed from here.
var NV_API = ${js(NUVIO_API)}, NV_KEY = ${js(NUVIO_KEY)};
var nv = { token: null, profiles: [], has: {}, addonsOk: {}, busy: null, warned: null };
function smsg(text, kind) { var m = $("#smsg"); m.textContent = text; m.className = "nmsg" + (kind ? " " + kind : ""); }
function amsg(text, kind) { var m = $("#amsg"); m.textContent = text; m.className = "nmsg" + (kind ? " " + kind : ""); }
function nvCall(path, body, method) {
  var h = { apikey: NV_KEY, "Content-Type": "application/json", Accept: "application/json" };
  if (nv.token) h.Authorization = "Bearer " + nv.token;
  return fetch(NV_API + path, { method: method || "POST", headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}) })
    .then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var err = new Error((j && (j.msg || j.message || j.error_description)) || ("HTTP " + r.status)); err.status = r.status; err.code = j && j.error_code; throw err; }
        return j;
      });
    });
}
function nvError(e, what) {
  if (e && e.mine) return e.mine;
  if (e && e.code === "invalid_credentials") return "Wrong email or password.";
  if (e && e.code === "email_not_confirmed") return "Your Nuvio email isn't confirmed yet. Confirm it from Nuvio's email first.";
  if (e && e.status === 429) return "Too many tries. Wait a minute and try again.";
  if (e && e.status === 401) return "Nuvio signed you out. Sign in again.";
  if (e && !e.status) return "Couldn't reach Nuvio. Check your connection and try again.";
  return what + " Nuvio said: " + (e && e.message ? e.message : "unknown error") + ". You can use the copy and paste steps under Other ways to add collections instead.";
}
// Same JSON whatever the key order (Nuvio's database reorders keys).
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
  return JSON.stringify(v);
}
function profileOf(i) { return nv.profiles.filter(function (p) { return p.profile_index === i; })[0]; }
function pname(i) { var p = profileOf(i); return (p && p.name) || "Profile " + i; }
function unlocked() { return nv.profiles.filter(function (p) { return !p.pin_enabled; }); }
function addonProfile(i) { var p = profileOf(i); return p && p.uses_primary_addons ? 1 : i; } // such profiles use profile 1's addons
function isTfiAddon(a) { return String(a && a.url).indexOf(BASE.replace("https://", "").replace("http://", "")) >= 0; }
function hasTfi(list) { return (list || []).some(function (c) { return c && tfiIds.indexOf(c.id) >= 0; }); }
function mask(email) { var at = email.indexOf("@"); return at > 1 ? email.charAt(0) + "***" + email.slice(at) : email; }
function names(list) { return list.length < 2 ? list.join("") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1]; }
function renderProfiles() {
  var box = $("#nprofiles"); box.innerHTML = "";
  nv.profiles.forEach(function (p) {
    var i = p.profile_index, locked = !!p.pin_enabled, added = nv.has[i] === true;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "prof" + (locked ? " locked" : "") + (nv.busy === i || nv.busy === "all" && !locked ? " busy" : "");
    b.disabled = locked || nv.busy !== null;
    b.setAttribute("aria-label", locked ? pname(i) + ", locked with a PIN" : (added ? "Update TFI Movies in " : "Add TFI Movies to ") + pname(i));
    var av = document.createElement("span"); av.className = "av";
    av.textContent = (pname(i).charAt(0) || "?").toUpperCase();
    if (/^#[0-9a-fA-F]{3,8}$/.test(p.avatar_color_hex || "")) av.style.background = p.avatar_color_hex;
    var n = document.createElement("span"); n.className = "pn"; n.textContent = pname(i);
    b.appendChild(av); b.appendChild(n);
    if (locked || added) { var t = document.createElement("span"); t.className = "badge" + (locked ? " lk" : ""); t.textContent = locked ? "🔒 Locked" : "Added ✓"; b.appendChild(t); }
    if (!locked) b.addEventListener("click", function () { addOne(i); });
    box.appendChild(b);
  });
  var open = unlocked();
  $("#nallrow").hidden = open.length < 2; $("#nall").disabled = nv.busy !== null;
  $("#nhint").textContent = open.length ? "Tap a profile to add it." : "All your profiles are locked.";
  var locked = nv.profiles.filter(function (p) { return p.pin_enabled; }).map(function (p) { return pname(p.profile_index); });
  $("#nlocknote").hidden = !locked.length;
  $("#nlocknote").textContent = locked.length ? "🔒 " + names(locked) + (locked.length > 1 ? " are" : " is") + " locked with a PIN, and Nuvio doesn't let other sites unlock profiles. To add TFI Movies there, turn the PIN off in Nuvio for a moment and tap the profile here, then turn the PIN back on. Or open that profile in Nuvio and use the copy and paste steps under Other ways to add collections." : "";
}
// Read a profile's collections; null when Nuvio has nothing synced for it yet.
function pull(i) { return nvCall("/rest/v1/rpc/sync_pull_collections", { p_profile_id: i }).then(function (rows) { return rows && rows[0] ? rows[0] : null; }); }
// Make sure the TFI catalogs are installed where profile i takes its addons from. True when they were just installed.
function ensureAddon(i) {
  var ap = addonProfile(i), src = profileOf(ap);
  if (nv.addonsOk[ap] || src && src.pin_enabled) return Promise.resolve(false); // never write to a locked profile
  var fail = { mine: "TFI Movies was added, but the catalogs couldn't be installed. Use the Install button at the top of this page." };
  var list;
  // A push replaces the whole addon list, so it's read right before: nothing added meanwhile is lost.
  return nvCall("/rest/v1/addons?select=url,name,enabled,sort_order&profile_id=eq." + ap + "&order=sort_order", null, "GET")
    .then(function (now) {
      if (!Array.isArray(now)) throw fail;
      if (now.some(isTfiAddon)) return null;
      list = now.map(function (a, k) { var o = { url: a.url, enabled: a.enabled !== false, sort_order: k }; if (a.name) o.name = a.name; return o; });
      list.push({ url: BASE + "/manifest.json", enabled: true, sort_order: list.length });
      return nvCall("/rest/v1/rpc/sync_push_addons", { p_profile_id: ap, p_addons: list })
        .then(function () { return nvCall("/rest/v1/addons?select=url&profile_id=eq." + ap, null, "GET"); })
        .then(function (back) { if (!back || back.length !== list.length || !back.some(isTfiAddon)) throw fail; });
    }, function () { throw fail; })
    .then(function () { nv.addonsOk[ap] = true; return !!list; });
}
// Add or update TFI Movies on one profile. { skipped: true } when Nuvio has nothing synced and that wasn't confirmed.
function addTo(i, emptyOk) {
  var changed = false, had = false;
  return pull(i).then(function (row) {
    if (!row && !emptyOk) return { skipped: true };
    var cur = row ? (row.collections_json || []) : [];
    had = hasTfi(cur); // then it's only brought up to date (Nuvio's apps also rewrite some fields), not "added"
    var r = addTfi(JSON.stringify(cur));
    if (!r) throw { mine: pname(i) + "'s collections on Nuvio aren't in a form this page knows, so they were left alone. Use the copy and paste steps under Other ways to add collections." };
    var next = JSON.parse(r.text);
    changed = canon(next) !== canon(cur);
    return (changed ? nvCall("/rest/v1/rpc/sync_push_collections", { p_profile_id: i, p_collections_json: next })
      .then(function () { return pull(i); })
      .then(function (back) { if (!back || canon(back.collections_json) !== canon(next)) throw { mine: "Nuvio saved something different from what was sent for " + pname(i) + ". Open Nuvio and check its collections." }; })
      : Promise.resolve())
      .then(function () { nv.has[i] = true; return ensureAddon(i); })
      .then(function (installed) { return { added: !had, installed: installed }; });
  });
}
function showDone(added, same, installed, note) {
  var title = added.length ? "Added to " + names(added) : "TFI Movies is already in " + names(same);
  if (added.length && same.length) title += " (" + names(same) + " already had it)";
  $("#ndonetitle").textContent = title;
  $("#ndonesteps").hidden = !added.length && !installed;
  $("#ndonenote").textContent = (installed ? "The TFI Movies catalogs were installed too. " : "") + (note || "");
  $("#ndone").hidden = false;
}
function failed(e) {
  if (e && e.status === 401) { signedOut(); return smsg(nvError(e), "err"); } // the session ran out: back to the sign-in form, with why
  amsg(nvError(e, "Couldn't finish."), "err");
}
function addOne(i) {
  if (nv.busy !== null || !nv.token) return;
  var emptyOk = nv.warned === i; nv.warned = null;
  nv.busy = i; renderProfiles(); $("#ndone").hidden = true; amsg("Adding TFI Movies to " + pname(i) + "…");
  addTo(i, emptyOk).then(function (r) {
    if (r.skipped) {
      nv.warned = i;
      return amsg("Nuvio hasn't synced any collections for " + pname(i) + " yet. If it has collections in Nuvio, open Nuvio on that profile once first, or they could be replaced. If it has none, tap " + pname(i) + " again.", "err");
    }
    amsg("");
    showDone(r.added ? [pname(i)] : [], r.added ? [] : [pname(i)], r.installed);
  }).catch(failed).then(function () { nv.busy = null; renderProfiles(); });
}
$("#nall").addEventListener("click", function () {
  if (nv.busy !== null || !nv.token) return;
  nv.busy = "all"; nv.warned = null; renderProfiles(); $("#ndone").hidden = true; amsg("Adding TFI Movies to all profiles…");
  var added = [], same = [], skipped = [], installed = false;
  unlocked().reduce(function (chain, p) {
    return chain.then(function () {
      return addTo(p.profile_index, false).then(function (r) {
        if (r.skipped) skipped.push(pname(p.profile_index));
        else { (r.added ? added : same).push(pname(p.profile_index)); installed = installed || r.installed; }
      });
    });
  }, Promise.resolve()).then(function () {
    amsg("");
    var note = skipped.length ? names(skipped) + (skipped.length > 1 ? " were" : " was") + " skipped: Nuvio hasn't synced any collections there yet. Tap " + (skipped.length > 1 ? "each one" : "it") + " to add it on its own." : "";
    if (added.length || same.length) showDone(added, same, installed, note); else amsg(note, "err");
  }).catch(failed).then(function () { nv.busy = null; renderProfiles(); });
});
function signedOut() {
  nv.token = null; nv.profiles = []; nv.has = {}; nv.addonsOk = {}; nv.busy = null; nv.warned = null;
  $("#acctready").hidden = true; $("#acctin").hidden = false; $("#npass").value = ""; $("#ndone").hidden = true; amsg("");
}
$("#neye").addEventListener("click", function () {
  var show = $("#npass").type === "password";
  $("#npass").type = show ? "text" : "password";
  $("#neye").setAttribute("aria-pressed", show ? "true" : "false");
  $("#neye").setAttribute("aria-label", show ? "Hide password" : "Show password");
});
$("#acctform").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var email = $("#nemail").value.trim(), pass = $("#npass").value;
  if (!email || !pass) return smsg("Type your Nuvio email and password.", "err");
  $("#nsignin").disabled = true; smsg("Signing in…");
  nv.token = null;
  nvCall("/auth/v1/token?grant_type=password", { email: email, password: pass })
    .then(function (s) {
      if (!s || !s.access_token) throw new Error("no session");
      nv.token = s.access_token; $("#npass").value = "";
      $("#nwho").textContent = mask((s.user && s.user.email) || email);
      return nvCall("/rest/v1/rpc/sync_pull_profiles", {});
    })
    .then(function (profiles) {
      nv.profiles = (profiles || []).slice().sort(function (a, b) { return a.profile_index - b.profile_index; });
      if (!nv.profiles.length) nv.profiles = [{ profile_index: 1, name: "Main profile" }];
      // Which profiles already have TFI Movies (for the "Added" badges)
      return Promise.all(unlocked().map(function (p) {
        return pull(p.profile_index).then(function (row) { nv.has[p.profile_index] = !!row && hasTfi(row.collections_json); }, function () {});
      }));
    })
    .then(function () {
      smsg(""); $("#acctin").hidden = true; $("#acctready").hidden = false; amsg("");
      renderProfiles();
    })
    .catch(function (e) { nv.token = null; smsg(nvError(e, "Couldn't sign in."), "err"); if (e && e.code === "invalid_credentials") $("#npass").focus(); })
    .then(function () { $("#nsignin").disabled = false; });
});
function nvSignOut(keepalive) { // ends only this page's session, not the user's apps
  if (!nv.token) return;
  try { fetch(NV_API + "/auth/v1/logout?scope=local", { method: "POST", keepalive: !!keepalive, headers: { apikey: NV_KEY, Authorization: "Bearer " + nv.token } }).catch(function () {}); } catch (e) {}
}
$("#nsignout").addEventListener("click", function () { nvSignOut(false); signedOut(); smsg("Signed out.", "ok"); });
window.addEventListener("pagehide", function () { nvSignOut(true); });
})();
</script>
</body></html>`;
}

function tokenPage(t) {
  return page("TFI Movies · TMDB connected", `<h1>TMDB connected</h1>
<p>Last step: copy this key into Vercel.</p>
<textarea readonly onclick="this.select()">${esc(t.access_token)}</textarea>
<ol><li>In Vercel open <b>tfi-movies → Settings → Environment Variables</b>.</li>
<li>Add <b>Key</b> <code>TMDB_USER_TOKEN</code> with the text above as the <b>Value</b>, and save.</li>
<li>Go to <b>Deployments</b>, click <b>⋯</b> on the newest one and choose <b>Redeploy</b>.</li>
<li>Open <a href="/sync">/sync</a> to create and fill your lists now. After that they update by themselves every day.</li></ol>
<p class="mut">Keep this key private. It lets this app edit lists in your TMDB account (account id ${esc(t.account_id || "")}).</p>`);
}

// ---------- Router ----------
function send(res, status, body, cacheSeconds, type = "application/json; charset=utf-8", headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", cacheSeconds
    ? `public, max-age=${Math.min(cacheSeconds, 3600)}, s-maxage=${cacheSeconds}, stale-while-revalidate=86400, stale-if-error=604800`
    : "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body, null, typeof body === "object" && body?.lists ? 2 : 0));
}

const decodeSeg = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const cookie = (req, name) => (String(req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "=")) || "").slice(name.length + 1);

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  let path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/index" && /^sync(-series)?$/.test(url.searchParams.get("task") || "")) path = `/${url.searchParams.get("task")}`;
  const ttl = CACHE_HOURS * 3600;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  const isLocal = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|192\.168\.|10\.)/.test(host);
  const proto = String(req.headers["x-forwarded-proto"] || (isLocal ? "http" : "https")).split(",")[0].trim();
  const base = `${proto}://${host}`;

  try {
    if (req.method === "OPTIONS") return send(res, 204, "", 0);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" }, 0);
    // Configured addon links: /<keys>/manifest.json, /<keys>/catalog/..., /<keys>/meta/..., /<keys>/configure
    let keys = null;
    const cm = path.match(/^\/([a-z0-9,%-]+)(\/(?:manifest\.json|configure|catalog\/.+|meta\/.+))$/i);
    if (cm && (keys = parseConfig(cm[1]))) path = cm[2];
    if (path === "/" || path === "/configure") {
      // No board data in time: the page goes out without the board, and is kept only 5 minutes so the next build retries.
      const data = await Promise.race([landingData(path === "/").catch(() => null), sleep(4000).then(() => null)]);
      return send(res, 200, landing(host, base, data || { board: [], lists: {} }, keys || ALL_KEYS, path === "/configure" ? "cats" : "app"), data ? 3600 : 300, "text/html; charset=utf-8");
    }
    if (path === "/manifest.json") return send(res, 200, manifest(base, keys || ALL_KEYS), 3600);
    // What the home server's daily Telugu-audio check looks up
    if (path === "/candidates.json") {
      const media = url.searchParams.get("type") === "tv" ? "tv" : "movie";
      return send(res, 200, await candidates(media), 10800);
    }
    if (path === "/logo.png" || path === "/tfi-logo.png") return send(res, 200, Buffer.from(LOGO_PNG_BASE64, "base64"), 604800, "image/png");

    // The home page's posters. Fetched from TMDB here and kept by Vercel for 30 days, so visitors' browsers never
    // contact TMDB (Indian networks slow it down). Only a bare TMDB file name is accepted, and no API key is involved.
    let pm = path.match(/^\/poster\/([A-Za-z0-9]{8,64}\.jpg)$/);
    if (pm) {
      const r = await fetch(`${IMG}w185/${pm[1]}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!r || !r.ok) return send(res, 404, { error: "not found" }, 0, undefined, { "Cache-Control": "public, max-age=60, s-maxage=60" });
      return send(res, 200, Buffer.from(await r.arrayBuffer()), 0, "image/jpeg", { "Cache-Control": "public, max-age=2592000, s-maxage=2592000, immutable" });
    }
    // The headings' typeface (Outfit Bold, the one on the Nuvio covers). Loaded only here: the font file is big.
    if (path === "/fonts/outfit-bold.ttf") {
      const { FONT_BOLD_BASE64 } = await import("../lib/fonts.js");
      return send(res, 200, Buffer.from(FONT_BOLD_BASE64, "base64"), 0, "font/ttf", { "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable" });
    }

    // Nuvio collection: the file to import, and each folder's art
    if (path === "/nuvio-collections.json") return send(res, 200, JSON.stringify(nuvioCollection(base), null, 2), 3600);
    let m = path.match(/^\/art\/([a-z-]+)\/([a-z]+\.[a-z]+)$/);
    if (m) {
      const def = ALL_DEFS.find((d) => d.key === m[1]);
      if (!def || !ART_FILES[m[2]]) return send(res, 404, { error: "not found" }, 0);
      const art = await import("../lib/art.js"); // loaded only here: the drawing library is big, and nothing else needs it
      const spec = await artSpec(def);
      // The ETag names what the image is drawn from, so it changes exactly when the top of the list does.
      const headers = { "Cache-Control": artCache(), ETag: `"${createHash("sha1").update(JSON.stringify([art.VERSION, m[2], spec])).digest("base64url")}"` };
      if (req.headers["if-none-match"] === headers.ETag) return send(res, 304, "", 0, ART_FILES[m[2]], headers);
      return send(res, 200, await art[m[2].split(".")[0]](spec), 0, ART_FILES[m[2]], headers);
    }

    // Daily list sync: /sync for movies, /sync-series for series (Vercel cron calls both; you can also open them in a browser)
    if (path === "/sync" || path === "/sync-series") {
      if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}` && url.searchParams.get("key") !== CRON_SECRET)
        return send(res, 401, { error: "unauthorized" }, 0);
      return send(res, 200, await syncLists(path === "/sync" ? "movie" : "tv"), 0);
    }

    // What may need a look: possibly missing films, and news reports that couldn't be matched
    if (path === "/review" || path === "/review.json") {
      const r = await review();
      if (path === "/review.json") return send(res, 200, { generated_at: new Date().toISOString(), news_stats: r.news.stats, missing: r.missing, unsure: r.news.unsure, not_found: r.news.notFound, matched: r.news.matched }, 0);
      return send(res, 200, page("TFI Movies · Review", reviewHtml({ news: r.news, missing: r.missing, inLists: r.inLists, generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", esc })), 0, "text/html; charset=utf-8");
    }

    // One-time: connect your TMDB account so the sync can edit your lists.
    // Once connected, reconnecting needs /tmdb-connect?key=<CRON_SECRET>, so visitors can't use it.
    const connected = () => send(res, 403, page("TFI Movies", `<p>This addon is already connected to TMDB.</p><p><a href="/">Back to TFI Movies</a></p>`), 0, "text/html; charset=utf-8");
    if (path === "/tmdb-connect" && USER_TOKEN && !(CRON_SECRET && url.searchParams.get("key") === CRON_SECRET)) return connected();
    if (path === "/tmdb-callback" && USER_TOKEN && !cookie(req, "tmdb_rt")) return connected();
    if (path === "/tmdb-connect") {
      if (!READ_TOKEN) throw new Error("Connecting needs your TMDB 'API Read Access Token' (the long one starting with eyJ). Add it in Vercel as TMDB_READ_TOKEN, redeploy, and try again.");
      const { request_token } = await tmdb4("POST", "/auth/request_token", READ_TOKEN, { redirect_to: `${base}/tmdb-callback` });
      return send(res, 302, "", 0, "text/plain", {
        Location: `https://www.themoviedb.org/auth/access?request_token=${encodeURIComponent(request_token)}`,
        "Set-Cookie": `tmdb_rt=${request_token}; Path=/; Max-Age=900; HttpOnly; SameSite=Lax${proto === "https" ? "; Secure" : ""}`,
      });
    }
    if (path === "/tmdb-callback") {
      const request_token = cookie(req, "tmdb_rt") || url.searchParams.get("request_token");
      if (!request_token || !READ_TOKEN) return send(res, 400, page("TFI Movies", `<p>Start again from <a href="/tmdb-connect">/tmdb-connect</a>.</p>`), 0, "text/html; charset=utf-8");
      const t = await tmdb4("POST", "/auth/access_token", READ_TOKEN, { request_token });
      return send(res, 200, tokenPage(t), 0, "text/html; charset=utf-8", { "Set-Cookie": "tmdb_rt=; Path=/; Max-Age=0" });
    }

    m = path.match(/^\/catalog\/(movie|series)\/([^/]+?)(?:\/([^/]+))?\.json$/);
    if (m) {
      const body = await catalog(m[1], decodeSeg(m[2]), new URLSearchParams(m[3] || ""));
      if (!body) return send(res, 404, { error: "unknown catalog", metas: [] }, 0);
      return send(res, 200, body, ttl);
    }
    m = path.match(/^\/meta\/(movie|series)\/([^/]+)\.json$/);
    if (m) {
      const id = decodeSeg(m[2]);
      if (!/^tmdb:\d+$/.test(id)) return send(res, 404, { error: "unsupported id", meta: null }, 0);
      return send(res, 200, m[1] === "series" ? await seriesMeta(id) : await meta(id), m[1] === "series" ? ttl : 86400);
    }
    return send(res, 404, { error: "not found" }, 0);
  } catch (err) {
    console.error(err);
    return send(res, 502, { error: String(err.message || err), metas: [] }, 0);
  }
}
