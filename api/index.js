// TFI Movies — keeps 8 public TMDB lists up to date (daily): 4 of movies, 4 of web series. It serves the
// same catalogs as a Stremio addon (backup). Runs as a single Vercel serverless function.

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
// old show comes up next to brand-new shows. Seasons are looked up for shows with a recent episode and
// shows that started in the last year; older shows keep their first-episode date.
// Series reported as new on OTT in the news are added too (TMDB often misses aha / ETV Win originals). Their news date
// is used when TMDB has no started season for them yet, or only an older season than the news reports.
async function discoverSeries(def, skip, count, news = seriesNewsMatches(), audio = null) {
  if (def.dubbed && !audio) audio = await getAudio();
  if (def.dubbed && !audio) return Object.assign([], { candidates: 0 });
  if (!def.dubbed && skip >= 300) return (await discoverOtt(def, skip, count)).filter((s) => !skipTitle(s));
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
  const recent = daysAgo(365);
  const infos = await mapLimit(pool, CONCURRENCY, (s) =>
    s.viaNews || airingIds.has(s.id) || newsBy.has(s.id) || (s.first_air_date || "") >= recent ? showInfo(s.id) : null);
  const ranked = pool.map((s, i) => {
    const info = infos[i];
    if (info?.serial) return null;
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
    // Daily soaps have hundreds of episodes a season; reality and talk shows are typed as such on TMDB.
    const serial = (SERIES_MAX_EPISODES > 0 && seasons.some((s) => s.episode_count > SERIES_MAX_EPISODES)) ||
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
    let notAdded = [];
    if (!unchanged) {
      if (current.length) {
        // Delete the items one batch at a time, not with /clear: TMDB finishes a clear a moment later,
        // which wiped (or refused as duplicates) the first batch added straight after it.
        const all = current.map((i) => ({ media_type: i.media_type || "movie", media_id: i.id }));
        for (const c of chunks(all, 50)) await tmdb4("DELETE", `/list/${list.id}/items`, USER_TOKEN, { items: c });
        await sleep(1500);
      }
      const add = async (ids) => {
        const failed = [];
        for (const c of chunks(ids, 50)) {
          const r = await tmdb4("POST", `/list/${list.id}/items`, USER_TOKEN, { items: c.map((id) => ({ media_type: media, media_id: id })) });
          failed.push(...(r.results || []).filter((x) => x.success === false).map((x) => x.media_id));
        }
        return failed;
      };
      notAdded = await add(wanted);
      if (notAdded.length) { await sleep(2000); notAdded = await add(notAdded); } // out of order until tomorrow's rebuild
    }
    let note = notAdded.length ? `TMDB refused ${notAdded.length} ${count}: ${notAdded.join(", ")}` : undefined;
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
    version: "2.7.0",
    name: "TFI Movies",
    description: "Movies and web series with Telugu audio, new on Indian OTT: the latest Telugu releases, plus Tamil, Malayalam, Kannada, English and Hindi titles dubbed in Telugu. Refreshed every day. Metadata by TMDB.",
    logo: `${base}/tfi-logo.png`,
    resources: ["catalog", { name: "meta", types, idPrefixes: ["tmdb:"] }],
    types,
    idPrefixes: ["tmdb:"],
    catalogs: defs.map((d) => ({ type: d.media === "tv" ? "series" : "movie", id: d.id, name: d.name, extra: [{ name: "skip" }] })),
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

async function catalog(type, id, extra) {
  const def = (type === "series" ? SERIES : CATALOGS)[id];
  if (!def) return null;
  const skipRaw = Number(extra.get("skip") || 0);
  const skip = Number.isFinite(skipRaw) ? Math.max(0, Math.floor(skipRaw)) : 0;
  let items = null;
  if (skip === 0) items = await listItems(def).then((l) => (l && l.length ? l.filter((i) => (i.media_type || "movie") === def.media) : null)).catch(() => null);
  if (!items) items = def.media === "tv" ? await discoverSeries(def, skip, PAGE_SIZE) : await discover(def, skip, PAGE_SIZE);
  const ids = await mapLimit(items, CONCURRENCY, (m) => imdbId(m.id, def.media));
  return { metas: items.map((m, i) => toPreview(m, ids[i], type)) };
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

// Landing page extras: TMDB list links. Best effort: the page also works without them.
async function landingData() {
  const lists = Object.fromEntries(await Promise.all(ALL_DEFS.map(async (def) => [def.id, (await findList(def))?.id])));
  return { lists };
}

const PLATFORM_NAMES = ["Netflix", "Prime Video", "JioHotstar", "aha", "ZEE5", "SonyLIV", "Sun NXT", "ETV Win"];
const REPO_URL = "https://github.com/anonvibes/TFI";

// keys: the catalogs switched on, in the order Stremio shows them (a configured link's /configure page opens with its own choice)
function landing(host, base, data, keys = ALL_KEYS) {
  const cfg = configPath(keys);
  const manifestUrl = `${base}${cfg}/manifest.json`;
  const appInstall = `stremio://${host}${cfg}/manifest.json`;
  const webInstall = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;
  const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const keysOf = (f) => ALL_DEFS.filter(f).map((d) => d.key);
  const presets = {
    all: ["Everything", ALL_KEYS],
    telugu: ["Telugu originals", keysOf((d) => !d.dubbed)],
    dubbed: ["Dubbed only", keysOf((d) => d.dubbed)],
    movies: ["Movies only", keysOf((d) => d.media === "movie")],
    series: ["Series only", keysOf((d) => d.media === "tv")],
  };
  const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
  const names = Object.fromEntries(ALL_DEFS.map((d) => [d.key, [d.name, d.media === "tv" ? "Series" : "Movies"]]));
  const icon = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const card = (d) => {
    const on = keys.includes(d.key);
    const list = data.lists?.[d.id];
    return `<label class="cat${on ? " on" : ""}">
  <span class="cat-top"><span class="cat-name">${esc(d.name)}</span><span class="sw"><input type="checkbox" value="${esc(d.key)}"${on ? " checked" : ""} aria-label="${esc(d.name)}"><i></i></span></span>
  <span class="cat-about">${esc(d.about)}</span>
  <span class="cat-foot"><span class="tag${d.dubbed ? "" : " te"}">${d.dubbed ? "Telugu audio checked" : "Made in Telugu"}</span>${list ? `<a href="https://www.themoviedb.org/list/${list}" target="_blank" rel="noopener">TMDB list ↗</a>` : ""}</span>
</label>`;
  };
  const group = (title, defs) => `<div class="group"><h3>${title}</h3><div class="cats">${Object.values(defs).map(card).join("")}</div></div>`;
  const desc = "Free Stremio addon: movies and web series with Telugu audio, new on Indian OTT. Telugu originals plus Tamil, Malayalam, Kannada, English and Hindi titles dubbed in Telugu. Refreshed every day.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TFI Movies · Stremio addon: new movies and series in Telugu</title>
<meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#0a0712">
<meta property="og:title" content="TFI Movies"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(base)}/tfi-logo.png"><meta property="og:url" content="${esc(base)}/">
<link rel="icon" type="image/png" href="/tfi-logo.png">
<style>
:root{--bg:#0a0712;--fg:#f5f2ff;--mut:#a79fbd;--dim:#756d8d;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.15);--card:rgba(255,255,255,.035);--card2:rgba(255,255,255,.07);
  --acc:#a855f7;--acc2:#e879f9;--grad:linear-gradient(135deg,#8b5cf6,#d946ef);--ok:#4ade80;--no:#f87171;--maybe:#fbbf24;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:80px;background:var(--bg)}
body{margin:0;color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
  background:radial-gradient(900px 520px at 12% -12%,rgba(139,92,246,.30),transparent 60%),radial-gradient(720px 440px at 96% 4%,rgba(217,70,239,.16),transparent 60%)}
a{color:var(--acc2)}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.top{position:sticky;top:0;z-index:20;background:rgba(10,7,18,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:24px;height:64px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;color:var(--fg);text-decoration:none;letter-spacing:-.01em}
.brand img{width:30px;height:30px;border-radius:8px}
nav{display:flex;align-items:center;gap:2px;margin-left:auto}
nav a{color:var(--mut);text-decoration:none;font-size:14px;padding:6px 12px;border-radius:8px}
nav a:hover{color:var(--fg);background:var(--card2)}
nav a.gh{border:1px solid var(--line2);margin-left:8px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 18px;border-radius:10px;font-family:inherit;font-size:15px;font-weight:600;line-height:1.2;
  text-decoration:none;color:var(--fg);border:1px solid var(--line2);background:var(--card2);cursor:pointer;white-space:nowrap;transition:filter .15s,background .15s}
.btn:hover{background:rgba(255,255,255,.11)}
.btn.primary{background:var(--grad);border-color:transparent;color:#fff;box-shadow:0 6px 24px rgba(168,85,247,.35)}
.btn.primary:hover{filter:brightness(1.1)}
.btn.lg{padding:14px 24px;font-size:16px;border-radius:12px}
.btn svg{width:18px;height:18px}
.hero{display:grid;grid-template-columns:1.3fr .7fr;gap:48px;align-items:center;padding:76px 0 60px}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#e9d5ff;background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.35);border-radius:999px;padding:5px 12px;margin-bottom:20px}
.badge .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(74,222,128,.2)}
h1{font-size:clamp(38px,6vw,66px);line-height:1.03;margin:0 0 18px;letter-spacing:-.035em;font-weight:800}
h1 em{font-style:normal;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{color:var(--mut);font-size:18px;margin:0 0 30px;max-width:580px}
.ctas{display:flex;flex-wrap:wrap;gap:12px}
.stats{display:flex;flex-wrap:wrap;gap:10px 28px;list-style:none;padding:0;margin:34px 0 0;color:var(--mut);font-size:14px}
.stats b{color:var(--fg);font-size:15px}
.art{position:relative;display:grid;place-items:center}
.art::before{content:"";position:absolute;width:78%;aspect-ratio:1;border-radius:50%;background:var(--grad);filter:blur(72px);opacity:.35}
.art img{position:relative;width:100%;max-width:290px;height:auto;aspect-ratio:1;border-radius:56px;border:1px solid var(--line2);display:block}
section{padding:56px 0}
.eyebrow{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--acc2);margin:0 0 8px}
h2{font-size:clamp(26px,3.5vw,36px);line-height:1.15;margin:0 0 10px;letter-spacing:-.025em}
.sub{color:var(--mut);margin:0 0 28px;max-width:660px}
.presets{display:flex;flex-wrap:wrap;gap:4px;padding:5px;border:1px solid var(--line);background:var(--card);border-radius:12px;width:max-content;max-width:100%;margin:0 0 28px}
.presets button{font:inherit;font-size:14px;font-weight:500;color:var(--mut);background:transparent;border:0;border-radius:8px;padding:7px 14px;cursor:pointer}
.presets button:hover{color:var(--fg)}
.presets button.on{background:var(--card2);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line2)}
.config{display:grid;grid-template-columns:1fr 340px;gap:28px;align-items:start}
.group+.group{margin-top:28px}
h3{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin:0 0 12px}
.cats{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.cat{display:flex;flex-direction:column;gap:8px;padding:16px 18px;border:1px solid var(--line);background:var(--card);border-radius:14px;cursor:pointer;transition:border-color .15s,background .15s}
.cat:hover{border-color:var(--line2)}
.cat.on{border-color:rgba(168,85,247,.55);background:linear-gradient(180deg,rgba(168,85,247,.11),rgba(168,85,247,.03))}
.cat-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
.cat-name{font-weight:650;font-size:16px;line-height:1.3}
.cat-about{color:var(--mut);font-size:14px;line-height:1.5;flex:1}
.cat-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.cat-foot a{color:var(--mut);text-decoration:none}
.cat-foot a:hover{color:var(--fg)}
.tag{font-size:12px;color:#d8b4fe;background:rgba(168,85,247,.13);border-radius:6px;padding:2px 8px}
.tag.te{color:#86efac;background:rgba(74,222,128,.1)}
.sw{position:relative;width:42px;height:24px;flex:none}
.sw input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1}
.sw i{position:absolute;inset:0;border-radius:999px;background:rgba(255,255,255,.15);transition:background .2s}
.sw i::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:transform .2s}
.sw input:checked+i{background:var(--grad)}
.sw input:checked+i::after{transform:translateX(18px)}
.sw input:focus-visible+i{outline:2px solid var(--acc2);outline-offset:2px}
.panel{position:sticky;top:84px;border:1px solid var(--line);background:rgba(22,15,38,.8);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-radius:16px;padding:20px}
.panel .head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.panel h4{margin:0;font-size:17px}
.mut{color:var(--mut);font-size:13px}
.mut b{color:var(--fg)}
.note{display:flex;justify-content:space-between;gap:8px;color:var(--dim);font-size:13px;margin:4px 0 14px}
.link{font:inherit;font-size:13px;color:var(--mut);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.link:hover{color:var(--fg)}
.link:disabled{visibility:hidden}
#order{list-style:none;margin:0 0 18px;padding:0;display:grid;gap:6px}
#order li{display:flex;align-items:center;gap:10px;padding:7px 7px 7px 10px;border:1px solid var(--line);background:var(--card);border-radius:10px;font-size:14px}
#order .num{width:22px;height:22px;flex:none;display:grid;place-items:center;border-radius:6px;background:var(--card2);color:var(--mut);font-size:12px;font-weight:600}
#order .oname{flex:1;min-width:0;line-height:1.3}
#order small{display:block;color:var(--dim);font-size:12px}
#order button{width:28px;height:28px;flex:none;display:grid;place-items:center;border:1px solid var(--line);background:transparent;color:var(--mut);border-radius:7px;cursor:pointer;padding:0}
#order button:hover:not(:disabled){color:var(--fg);border-color:var(--line2);background:var(--card2)}
#order button:disabled{opacity:.25;cursor:default}
#order button svg{width:14px;height:14px}
#order .empty{justify-content:center;color:var(--mut);border-style:dashed;padding:16px}
.panel .btn{width:100%}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.row2 .btn{font-size:14px;padding:9px 12px}
.copy{display:flex;border:1px solid var(--line);border-radius:10px;background:rgba(0,0,0,.35);margin-top:14px}
.copy input{flex:1;min-width:0;background:transparent;border:0;color:var(--mut);padding:9px 12px;font:12px ui-monospace,Consolas,monospace}
.hint{color:var(--dim);font-size:12px;margin:8px 0 0}
.none .js-install,.none .js-web,.none .js-copy{opacity:.4;pointer-events:none}
.checks{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.check,.steps li{border:1px solid var(--line);background:var(--card);border-radius:14px;padding:20px}
.ic{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;margin-bottom:12px}
.ic svg{width:18px;height:18px}
.ic.ok{background:rgba(74,222,128,.12);color:var(--ok)}
.ic.no{background:rgba(248,113,113,.12);color:var(--no)}
.ic.maybe{background:rgba(251,191,36,.12);color:var(--maybe)}
.check h4{margin:0 0 6px;font-size:16px}
.check p{margin:0;color:var(--mut);font-size:14px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;list-style:none;padding:0;margin:0 0 36px;counter-reset:s}
.steps li{counter-increment:s;color:var(--mut);font-size:15px}
.steps li::before{content:counter(s);display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--grad);color:#fff;font-weight:700;margin-bottom:12px}
.steps b{color:var(--fg);display:block;margin-bottom:4px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips span{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:7px 16px;font-size:14px}
.faq{max-width:800px}
details{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:0 18px;margin-bottom:10px}
summary{cursor:pointer;font-weight:600;padding:15px 0;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";color:var(--mut);font-size:22px;font-weight:400;line-height:1;transition:transform .2s}
details[open] summary::after{transform:rotate(45deg)}
details p{color:var(--mut);margin:0 0 16px}
footer{border-top:1px solid var(--line);margin-top:24px;padding:28px 0 48px;color:var(--dim);font-size:13px}
footer p{margin:4px 0}
footer a{color:var(--mut)}
.mbar{display:none}
@media (max-width:900px){
  .hero{grid-template-columns:1fr;text-align:center;padding:40px 0 36px;gap:28px}
  .art{order:-1}.art img{max-width:150px;border-radius:34px}
  .lead{margin-left:auto;margin-right:auto}.ctas,.stats{justify-content:center}
  .config{grid-template-columns:1fr}.panel{position:static}
  .checks,.steps{grid-template-columns:1fr}
  nav a:not(.gh){display:none}
  body{padding-bottom:84px}
  .mbar{display:flex;position:fixed;left:12px;right:12px;bottom:12px;z-index:30;align-items:center;justify-content:space-between;gap:12px;padding:10px 10px 10px 16px;
    border:1px solid var(--line2);border-radius:14px;background:rgba(22,15,38,.94);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.5)}
}
@media (max-width:560px){.wrap{padding:0 16px}.cats{grid-template-columns:1fr}.presets{width:auto}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}html{scroll-behavior:auto}}
</style></head><body>
<header class="top"><div class="wrap">
  <a class="brand" href="/"><img src="/tfi-logo.png" alt="">TFI Movies</a>
  <nav><a href="#customize">Customize</a><a href="#check">Telugu check</a><a href="#install">Install</a><a href="#faq">FAQ</a><a class="gh" href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></nav>
</div></header>

<main class="wrap">
<section class="hero">
  <div>
    <span class="badge"><span class="dot"></span>Telugu audio only · refreshed daily</span>
    <h1>New on OTT,<br><em>all in Telugu.</em></h1>
    <p class="lead">A free Stremio addon with the latest Telugu movies and web series, plus Tamil, Malayalam, Kannada, English and Hindi titles dubbed in Telugu. Every title has a Telugu audio track, confirmed or very likely.</p>
    <div class="ctas">
      <a class="btn primary lg js-install" href="${esc(appInstall)}">${icon("M8 3v10M3 8h10")}Install in Stremio</a>
      <a class="btn lg" href="#customize">Customize catalogs</a>
    </div>
    <ul class="stats"><li><b>${ALL_DEFS.length}</b> catalogs</li><li><b>${PLATFORM_NAMES.length}</b> OTT platforms</li><li><b>Daily</b> refresh</li><li><b>Free</b>, no account</li></ul>
  </div>
  <div class="art"><img src="/tfi-logo.gif" onerror="this.onerror=null;this.src='/tfi-logo.png'" width="290" height="290" alt="TFI Movies logo"></div>
</section>

<section id="customize">
  <p class="eyebrow">Customize</p>
  <h2>Build your addon</h2>
  <p class="sub">Switch catalogs on or off and set the order Stremio shows them in. Your choice is saved in the addon link, so there's no account to make.</p>
  <div class="presets" id="presets" role="group" aria-label="Presets">${Object.entries(presets).map(([p, [label, list]]) => `<button type="button" data-p="${p}" aria-pressed="${sameSet(list, keys)}"${sameSet(list, keys) ? ' class="on"' : ""}>${label}</button>`).join("")}</div>
  <div class="config">
    <div id="cats">${group("Movies", CATALOGS)}${group("Series", SERIES)}</div>
    <aside class="panel">
      <div class="head"><h4>Your addon</h4><span class="mut"><b class="js-count">${keys.length}</b> of ${ALL_KEYS.length} catalogs</span></div>
      <div class="note"><span>Stremio shows them in this order.</span><button type="button" class="link" id="resetorder">Reset order</button></div>
      <ol id="order">${keys.map((k, i) => `<li><span class="num">${i + 1}</span><span class="oname">${esc(names[k][0])}<small>${names[k][1]}</small></span></li>`).join("")}</ol>
      <a class="btn primary js-install" href="${esc(appInstall)}">Install in Stremio</a>
      <div class="row2"><a class="btn js-web" href="${esc(webInstall)}" target="_blank" rel="noopener">Stremio Web</a><button type="button" class="btn js-copy" data-label="Copy link">Copy link</button></div>
      <div class="copy"><input id="murl" value="${esc(manifestUrl)}" readonly aria-label="Addon link"></div>
      <p class="hint">Install button doesn't open Stremio? Copy the link and paste it into the search box on Stremio's Addons page.</p>
    </aside>
  </div>
</section>

<section id="check">
  <p class="eyebrow">Telugu audio only</p>
  <h2>Every title has a Telugu track</h2>
  <p class="sub">Telugu films and series are in automatically. Every dubbed title is checked each day against the audio languages JustWatch and Netflix list, and against OTT release news.</p>
  <div class="checks">
    <div class="check"><div class="ic ok">${icon("M3 8.5l3.2 3.2L13 5")}</div><h4>Confirmed</h4><p>JustWatch or Netflix lists Telugu audio, it's on ETV Win, or OTT release news (Sacnilk, 123telugu) says so.</p></div>
    <div class="check"><div class="ic no">${icon("M4 4l8 8M12 4l-8 8")}</div><h4>Left out</h4><p>The services list the audio languages and Telugu isn't one of them, or JustWatch doesn't know the title and no news confirms Telugu.</p></div>
    <div class="check"><div class="ic maybe">${icon("M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M8 12h.01")}</div><h4>Kept, unconfirmed</h4><p>JustWatch knows the title but no service lists its audio languages yet (mostly Sun NXT), so it gets the benefit of the doubt.</p></div>
  </div>
</section>

<section id="install">
  <p class="eyebrow">Get started</p>
  <h2>Install in a minute</h2>
  <p class="sub">TFI Movies adds catalogs to Stremio: posters, details, ratings and trailers. Watch on the streaming service that has the title.</p>
  <ol class="steps">
    <li><b>Get Stremio</b>It's free for Windows, Mac, Android, iPhone and Android TV at <a href="https://www.stremio.com/downloads" target="_blank" rel="noopener">stremio.com</a>.</li>
    <li><b>Install TFI Movies</b>Press <a href="#customize">Install in Stremio</a> (customize first if you like), then <strong>Install</strong> in the window that opens.</li>
    <li><b>Open Board or Discover</b>The TFI catalogs show up under Movies and Series.</li>
  </ol>
  <h3>Platforms covered</h3>
  <div class="chips">${PLATFORM_NAMES.map((p) => `<span>${esc(p)}</span>`).join("")}</div>
</section>

<section id="faq" class="faq">
  <p class="eyebrow">FAQ</p>
  <h2>Questions</h2>
  <details><summary>Does TFI Movies play videos?</summary><p>No. It adds catalogs: posters, details, ratings and trailers for what's new on Indian OTT. It doesn't host or link to any video. Watch on the streaming service that has the title.</p></details>
  <details><summary>How fresh are the catalogs?</summary><p>They update every morning (India time) from TMDB's streaming data, plus OTT release news from Sacnilk, 123telugu and 91mobiles, so new arrivals show up even before TMDB catches up.</p></details>
  <details><summary>Does every title have Telugu audio?</summary><p>That's the rule. See <a href="#check">how the Telugu check works</a>: a title goes in when Telugu is listed, or when JustWatch knows it but no service lists its audio languages yet. Found one without Telugu? <a href="${REPO_URL}/issues" target="_blank" rel="noopener">Tell us on GitHub</a>.</p></details>
  <details><summary>Can I hide catalogs or change their order?</summary><p>Yes. Under <a href="#customize">Customize</a>, switch off the ones you don't want and use the arrows to set their order, then install. Already installed? Open TFI Movies on Stremio's Addons page, press <b>Configure</b>, change your choice and install again.</p></details>
  <details><summary>Is it free? Can I see how it works?</summary><p>Yes, it's free and needs no account. The code is open source on <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>.</p></details>
</section>
</main>

<footer><div class="wrap">
  <p>TFI Movies v${esc(manifest(base).version)} · <a href="${REPO_URL}" target="_blank" rel="noopener">Source on GitHub</a></p>
  <p>Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a>. This product uses the TMDB API but is not endorsed or certified by TMDB. Not affiliated with Stremio or any streaming service.</p>
</div></footer>

<div class="mbar"><span class="mut"><b class="js-count">${keys.length}</b> of ${ALL_KEYS.length} catalogs</span><a class="btn primary js-install" href="${esc(appInstall)}">Install in Stremio</a></div>

<script>
(function () {
var KEYS = ${js(ALL_KEYS)}, NAMES = ${js(names)}, PRESETS = ${js(Object.fromEntries(Object.entries(presets).map(([p, v]) => [p, v[1]])))};
var BASE = ${js(base)}, HOST = ${js(host)}, UP = ${js(icon("M4 10l4-4 4 4"))}, DOWN = ${js(icon("M4 6l4 4 4-4"))};
var order = ${js(keys)};
var $ = function (s) { return document.querySelector(s); };
var all = function (s) { return [].slice.call(document.querySelectorAll(s)); };
var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
var sameSet = function (a, b) { return a.length === b.length && a.every(function (k) { return b.indexOf(k) >= 0; }); };
var defaultOrder = function () { return KEYS.filter(function (k) { return order.indexOf(k) >= 0; }); };
function moveBtn(k, d, label, off) {
  return '<button type="button" data-k="' + k + '" data-d="' + d + '" aria-label="Move ' + esc(NAMES[k][0]) + " " + label + '"' + (off ? " disabled" : "") + ">" + (d < 0 ? UP : DOWN) + "</button>";
}
function render() {
  var cfg = order.join(",") === KEYS.join(",") ? "" : "/" + order.join(",");
  var m = BASE + cfg + "/manifest.json";
  $("#murl").value = m;
  all(".js-install").forEach(function (a) { a.href = "stremio://" + HOST + cfg + "/manifest.json"; });
  all(".js-web").forEach(function (a) { a.href = "https://web.stremio.com/#/addons?addon=" + encodeURIComponent(m); });
  all(".js-count").forEach(function (e) { e.textContent = order.length; });
  all("#cats input").forEach(function (b) { b.checked = order.indexOf(b.value) >= 0; b.closest(".cat").classList.toggle("on", b.checked); });
  all("#presets button").forEach(function (b) { var on = sameSet(PRESETS[b.getAttribute("data-p")], order); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  $("#order").innerHTML = order.length ? order.map(function (k, i) {
    return '<li><span class="num">' + (i + 1) + '</span><span class="oname">' + esc(NAMES[k][0]) + "<small>" + NAMES[k][1] + "</small></span>"
      + moveBtn(k, -1, "up", i === 0) + moveBtn(k, 1, "down", i === order.length - 1) + "</li>";
  }).join("") : '<li class="empty">Switch on at least one catalog.</li>';
  $("#resetorder").disabled = order.join(",") === defaultOrder().join(",");
  document.body.classList.toggle("none", !order.length);
}
$("#cats").addEventListener("change", function (e) {
  var k = e.target.value, i = order.indexOf(k);
  if (!k) return;
  if (e.target.checked && i < 0) order.push(k);
  if (!e.target.checked && i >= 0) order.splice(i, 1);
  render();
});
$("#presets").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-p]");
  if (b) { order = PRESETS[b.getAttribute("data-p")].slice(); render(); }
});
$("#order").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-d]");
  if (!b) return;
  var k = b.getAttribute("data-k"), d = b.getAttribute("data-d"), i = order.indexOf(k), j = i + Number(d);
  if (i < 0 || j < 0 || j >= order.length) return;
  order.splice(j, 0, order.splice(i, 1)[0]);
  render();
  var next = document.querySelector('#order button[data-k="' + k + '"][data-d="' + d + '"]:not(:disabled)') || document.querySelector('#order button[data-k="' + k + '"]:not(:disabled)');
  if (next) next.focus();
});
$("#resetorder").addEventListener("click", function () { order = defaultOrder(); render(); });
all(".js-copy").forEach(function (b) {
  b.addEventListener("click", function () {
    var input = $("#murl"), label = b.getAttribute("data-label");
    var done = function () { b.textContent = "Copied!"; setTimeout(function () { b.textContent = label; }, 1600); };
    var fallback = function () { input.select(); document.execCommand("copy"); done(); };
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, fallback); else fallback();
  });
});
render();
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
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Cache-Control", cacheSeconds
    ? `public, max-age=${Math.min(cacheSeconds, 3600)}, s-maxage=${cacheSeconds}, stale-while-revalidate=86400, stale-if-error=604800`
    : "no-store");
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
      const data = await Promise.race([landingData().catch(() => null), sleep(4000).then(() => null)]);
      return send(res, 200, landing(host, base, data || { lists: {} }, keys || ALL_KEYS), data ? 3600 : 300, "text/html; charset=utf-8");
    }
    if (path === "/manifest.json") return send(res, 200, manifest(base, keys || ALL_KEYS), 3600);
    // What the home server's daily Telugu-audio check looks up
    if (path === "/candidates.json") {
      const media = url.searchParams.get("type") === "tv" ? "tv" : "movie";
      return send(res, 200, await candidates(media), 10800);
    }
    if (path === "/logo.png" || path === "/tfi-logo.png") return send(res, 200, Buffer.from(LOGO_PNG_BASE64, "base64"), 604800, "image/png");

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

    let m = path.match(/^\/catalog\/(movie|series)\/([^/]+?)(?:\/([^/]+))?\.json$/);
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
