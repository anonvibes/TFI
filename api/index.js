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
const EN_DUB_MIN_VOTES = env("EN_DUB_MIN_VOTES", "100");
const HINDI_MIN_VOTES = env("HINDI_MIN_VOTES", "0");
const MIN_RUNTIME = Number(env("MIN_RUNTIME", "60"));
const DUB_SERIES_MIN_VOTES = env("DUB_SERIES_MIN_VOTES", "0");
const EN_SERIES_MIN_VOTES = env("EN_SERIES_MIN_VOTES", "100");
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

const CATALOGS = {
  "tfi-streaming": {
    name: "Latest Streaming - TFI",
    about: "Telugu films streaming on Indian OTT, latest arrivals first.",
    langs: () => ["te"], minVotes: () => 0,
  },
  "tfi-dubbed": {
    name: "Latest Dubbed - TFI",
    about: "Tamil, Malayalam and Kannada films streaming on Indian OTT (most have Telugu audio), latest arrivals first.",
    langs: () => DUB_LANGS.split("|"), minVotes: () => Number(DUB_MIN_VOTES) || 0,
  },
  "tfi-english-dubbed": {
    name: "Latest English Dubbed - TFI",
    about: "Well-known English films streaming on Indian OTT (big releases usually have Telugu audio), latest arrivals first.",
    langs: () => ["en"], minVotes: () => Number(EN_DUB_MIN_VOTES) || 0,
  },
  "hindi-streaming": {
    name: "Latest Streaming - Hindi",
    about: "Hindi films streaming on Indian OTT, latest arrivals first.",
    langs: () => ["hi"], minVotes: () => Number(HINDI_MIN_VOTES) || 0,
  },
};
// Web series (TMDB "tv"). Ranked by when the newest series or season started.
const SERIES = {
  "tfi-series": {
    name: "Latest Series - TFI",
    about: "Telugu web series streaming on Indian OTT, newest series and seasons first.",
    langs: () => ["te"], minVotes: () => 0,
  },
  "tfi-dubbed-series": {
    name: "Latest Dubbed Series - TFI",
    about: "Tamil, Malayalam and Kannada web series streaming on Indian OTT (many have Telugu audio), newest series and seasons first.",
    langs: () => DUB_LANGS.split("|"), minVotes: () => Number(DUB_SERIES_MIN_VOTES) || 0,
  },
  "tfi-english-series": {
    name: "Latest English Series - TFI",
    about: "Well-known English web series streaming on Indian OTT (big ones usually have Telugu audio), newest series and seasons first.",
    langs: () => ["en"], minVotes: () => Number(EN_SERIES_MIN_VOTES) || 0,
  },
  "hindi-series": {
    name: "Latest Series - Hindi",
    about: "Hindi web series streaming on Indian OTT, newest series and seasons first.",
    langs: () => ["hi"], minVotes: () => Number(HINDI_SERIES_MIN_VOTES) || 0,
  },
};
for (const [defs, media] of [[CATALOGS, "movie"], [SERIES, "tv"]]) for (const def of Object.values(defs)) {
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
async function discover(def, skip, count, news = newsMatches()) {
  if (skip >= 300 || !(DIGITAL_DAYS > 0)) return discoverOtt(def, skip, count);
  const [ott, digital] = await Promise.all([discoverOtt(def, 0, skip + count), digitalReleases(def)]);
  const inOtt = new Set(ott.map((m) => m.id));
  const newsDate = new Map(news.map((n) => [n.id, n.date]));
  const seen = new Set();
  const pool = [...ott, ...digital].filter((m) => m && !seen.has(m.id) && seen.add(m.id));
  for (const n of news) if (!seen.has(n.id)) { seen.add(n.id); pool.push({ id: n.id, viaNews: true }); }
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
  return ranked.slice(skip, skip + count);
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

// What's streaming in India for a catalog, newest first (movies by release date, series by first episode).
async function ottParams(def) {
  const common = {
    ...def.query(),
    watch_region: REGION,
    with_watch_providers: (await getProviderIds()).join("|"),
    with_watch_monetization_types: "flatrate|free|ads",
    include_adult: false,
    language: LANG,
  };
  if (def.media === "tv") return { sort_by: "first_air_date.desc", ...common, "first_air_date.lte": today(),
    with_type: TV_TYPES, without_genres: TV_SKIP_GENRES, include_null_first_air_dates: false };
  return { sort_by: "primary_release_date.desc", ...common, "primary_release_date.lte": today(),
    "with_runtime.gte": MIN_RUNTIME > 0 ? MIN_RUNTIME : undefined };
}

async function discoverOtt(def, skip, count) {
  const path = `/discover/${def.media}`;
  const firstPage = Math.floor(skip / TMDB_PAGE) + 1;
  const lastPage = Math.min(Math.floor((skip + count - 1) / TMDB_PAGE) + 1, 500);
  if (firstPage > 500) return [];
  const params = await ottParams(def);
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
async function discoverSeries(def, skip, count, news = seriesNewsMatches()) {
  if (skip >= 300) return (await discoverOtt(def, skip, count)).filter((s) => !skipTitle(s));
  const [newest, airing] = await Promise.all([discoverOtt(def, 0, skip + count), recentlyAiring(def)]);
  const airingIds = new Set(airing.map((s) => s.id));
  const newsBy = new Map();
  for (const n of news) if (!newsBy.has(n.id) || (n.season || 1) > (newsBy.get(n.id).season || 1)) newsBy.set(n.id, n);
  const seen = new Set();
  const pool = [...airing, ...newest].filter((s) => s && !seen.has(s.id) && seen.add(s.id) && !skipTitle(s));
  for (const id of newsBy.keys()) if (!seen.has(id)) { seen.add(id); pool.push({ id, viaNews: true }); }
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
  }).filter(Boolean);
  ranked.sort((a, b) => b.ott_date.localeCompare(a.ott_date) || (b.first_air_date || "").localeCompare(a.first_air_date || ""));
  return ranked.slice(skip, skip + count);
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
  const report = [];
  for (const def of Object.values(isTv ? SERIES : CATALOGS)) {
    const ranked = isTv ? await discoverSeries(def, 0, LIST_SIZE, news.matched) : await discover(def, 0, LIST_SIZE, news.matched);
    const wanted = ranked.map((m) => m.id);
    const fromNews = ranked.filter((m) => m.via_news).map((m) => m.title);
    const description = `${def.about} Updated automatically every day by TFI Movies. Last update: ${today()}.`;
    let list = mine.find((l) => l.name === def.name);
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
    // keep the current list until TMDB recovers rather than emptying it.
    if (current.length >= 50 && wanted.length < current.length * 0.8) {
      report.push({ list: def.name, url: `https://www.themoviedb.org/list/${list.id}`, [count]: current.length, added: 0, removed: 0, reordered: false, ...(isTv ? {} : { from_news: [] }), note: `kept as it was: TMDB gave only ${wanted.length} ${isTv ? "series" : "films"}` });
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
    try { await tmdb4("PUT", `/list/${list.id}`, USER_TOKEN, { description, public: true, sort_by: "original_order.asc" }); }
    catch (e) { note = [note, `list settings not updated: ${e.message}`].filter(Boolean).join("; "); }
    report.push({ list: def.name, url: `https://www.themoviedb.org/list/${list.id}`, [count]: wanted.length, added, removed, reordered: !unchanged,
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
  return listIndex.lists.find((l) => l.name === def.name) || null;
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

function manifest(base) {
  return {
    id: "community.tfi.movies",
    version: "2.5.0",
    name: "TFI Movies",
    description: "Latest Telugu (TFI) movies and web series, Telugu-dubbed Tamil/Malayalam/Kannada and English titles, and new Hindi movies and series streaming on Indian OTT. Auto-updating, metadata by TMDB.",
    logo: `${base}/tfi-logo.png`,
    resources: ["catalog", { name: "meta", types: ["movie", "series"], idPrefixes: ["tmdb:"] }],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs: [
      ...Object.entries(CATALOGS).map(([id, c]) => ({ type: "movie", id, name: c.name, extra: [{ name: "skip" }] })),
      ...Object.entries(SERIES).map(([id, c]) => ({ type: "series", id, name: c.name, extra: [{ name: "skip" }] })),
    ],
    behaviorHints: { configurable: false, configurationRequired: false },
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

// Landing page extras: TMDB list links and the newest Telugu posters. Best effort: the page also works without them.
async function landingData() {
  const lists = Object.fromEntries(await Promise.all(Object.entries({ ...CATALOGS, ...SERIES }).map(async ([id, def]) => [id, (await findList(def))?.id])));
  const newest = async (def) => {
    const list = await findList(def);
    if (!list) return [];
    const d = await tmdb4("GET", `/list/${list.id}?language=${LANG}&page=1`, USER_TOKEN);
    return (d.results || []).filter((m) => m.poster_path).slice(0, 12);
  };
  const [movies, series] = await Promise.all([newest(CATALOGS["tfi-streaming"]), newest(SERIES["tfi-series"])]);
  return { lists, movies, series };
}

const PLATFORM_NAMES = ["Netflix", "Prime Video", "JioHotstar", "aha", "ZEE5", "SonyLIV", "Sun NXT", "ETV Win"];
const REPO_URL = "https://github.com/anonvibes/TFI";

function landing(host, base, data) {
  const manifestUrl = `${base}/manifest.json`;
  const webInstall = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;
  const strip = (title, items) => !items.length ? "" : `<h3>${esc(title)}</h3><div class="row">${items.map((m) => {
    const name = m.title || m.name || "";
    return `<a class="poster" href="https://www.themoviedb.org/${m.media_type === "tv" ? "tv" : "movie"}/${m.id}" target="_blank" rel="noopener" title="${esc(name)}"><img src="${IMG}w185${m.poster_path}" alt="${esc(name)}" loading="lazy" width="120" height="180"><span>${esc(name)}</span></a>`;
  }).join("")}</div>`;
  const cards = (defs) => Object.entries(defs).map(([id, def]) => `<div class="card"><h4>${esc(def.name)}</h4><p>${esc(def.about)}</p>${data.lists[id] ? `<a href="https://www.themoviedb.org/list/${data.lists[id]}" target="_blank" rel="noopener">View the list on TMDB →</a>` : ""}</div>`).join("");
  const desc = "Free Stremio addon: the latest Telugu movies and web series on Indian OTT, plus Telugu-dubbed, English and Hindi titles. Refreshed every day.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TFI Movies · Stremio addon for the latest Telugu movies and series on OTT</title>
<meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#0d0618">
<meta property="og:title" content="TFI Movies"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(base)}/tfi-logo.png"><meta property="og:url" content="${esc(base)}/">
<link rel="icon" type="image/png" href="/tfi-logo.png">
<style>
:root{--bg:#0d0618;--bg2:#1a0b33;--card:rgba(255,255,255,.05);--line:rgba(255,255,255,.1);--fg:#f4efff;--mut:#b7a9d6;--acc:#b26bff;--acc2:#e879f9;color-scheme:dark}
*{box-sizing:border-box}
html{background:radial-gradient(1200px 600px at 50% -10%,#3b1676 0%,transparent 60%),var(--bg);min-height:100%}
body{margin:0;color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.gridbg{position:fixed;left:-20%;right:-20%;bottom:0;height:45vh;z-index:-1;pointer-events:none;opacity:.5;transform:perspective(420px) rotateX(58deg);transform-origin:bottom;
  background:repeating-linear-gradient(90deg,rgba(178,107,255,.18) 0 1px,transparent 1px 64px),repeating-linear-gradient(0deg,rgba(178,107,255,.18) 0 1px,transparent 1px 44px);
  -webkit-mask-image:linear-gradient(transparent,#000 70%);mask-image:linear-gradient(transparent,#000 70%)}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;color:var(--fg);text-decoration:none}
.brand img{width:32px;height:32px;border-radius:8px}
.pill{color:var(--mut);text-decoration:none;font-size:14px;border:1px solid var(--line);padding:6px 14px;border-radius:999px}
.pill:hover{color:var(--fg);border-color:var(--acc)}
.hero{display:grid;grid-template-columns:auto 1fr;gap:44px;align-items:center;padding:36px 0 20px}
.hero .logo{width:210px;height:210px;border-radius:44px;box-shadow:0 0 70px rgba(178,107,255,.45);display:block}
h1{font-size:clamp(30px,5vw,48px);line-height:1.1;margin:0 0 14px;letter-spacing:-.02em}
h1 em{font-style:normal;background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{color:var(--mut);font-size:18px;margin:0 0 24px;max-width:560px}
.ctas{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:13px 22px;border-radius:12px;font-weight:600;text-decoration:none;color:#fff;border:1px solid var(--line);background:var(--card)}
.btn.primary{background:linear-gradient(135deg,#8b3dff,#c026d3);border-color:transparent;box-shadow:0 8px 30px rgba(168,85,247,.4)}
.btn:hover{filter:brightness(1.15)}
.copy{display:flex;max-width:520px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:rgba(0,0,0,.3)}
.copy input{flex:1;min-width:0;background:transparent;border:0;color:var(--mut);padding:11px 14px;font:13px ui-monospace,Consolas,monospace}
.copy button{border:0;border-left:1px solid var(--line);background:var(--card);color:var(--fg);padding:0 18px;font:600 14px system-ui,sans-serif;cursor:pointer}
.copy button:hover{background:rgba(255,255,255,.1)}
.hint{color:var(--mut);font-size:13px;margin:8px 0 0}
section{padding:26px 0}
h2{font-size:24px;margin:0 0 16px;letter-spacing:-.01em}
h3{font-size:15px;color:var(--mut);margin:18px 0 10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.row{display:flex;gap:14px;overflow-x:auto;padding-bottom:10px;scroll-snap-type:x mandatory;scrollbar-width:thin}
.poster{flex:0 0 120px;scroll-snap-align:start;color:var(--fg);text-decoration:none;font-size:13px}
.poster img{width:120px;height:180px;object-fit:cover;border-radius:10px;display:block;background:var(--bg2);transition:transform .15s,box-shadow .15s}
.poster:hover img{transform:translateY(-3px);box-shadow:0 10px 24px rgba(178,107,255,.35)}
.poster span{display:block;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card,.steps li{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.card h4{margin:0 0 6px;font-size:16px}
.card p{margin:0 0 10px;color:var(--mut);font-size:14px}
.card a{font-size:14px;text-decoration:none}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips span{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:6px 14px;font-size:14px}
.steps{counter-reset:s;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;padding:0;margin:0;list-style:none}
.steps li{counter-increment:s;color:var(--mut);font-size:15px}
.steps li::before{content:counter(s);display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#8b3dff,#c026d3);color:#fff;font-weight:700;margin-bottom:8px}
.steps b{color:var(--fg)}
details{border-bottom:1px solid var(--line);padding:14px 0}
summary{cursor:pointer;font-weight:600}
details p{color:var(--mut);margin:8px 0 0}
a{color:var(--acc2)}
footer{border-top:1px solid var(--line);margin-top:24px;padding:24px 0 48px;color:var(--mut);font-size:13px}
footer p{margin:4px 0}
@media (max-width:720px){.hero{grid-template-columns:1fr;text-align:center;gap:20px;padding-top:16px}.hero .logo{width:150px;height:150px;margin:0 auto;border-radius:32px}
  .lead{margin-left:auto;margin-right:auto}.ctas{justify-content:center}.copy{margin:0 auto}}
</style></head><body><div class="gridbg"></div>
<div class="wrap">
<header><a class="brand" href="/"><img src="/tfi-logo.png" alt="">TFI Movies</a><a class="pill" href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></header>

<div class="hero">
  <img class="logo" src="/tfi-logo.gif" onerror="this.onerror=null;this.src='/tfi-logo.png'" width="210" height="210" alt="TFI Movies logo">
  <div>
    <h1>The latest Telugu movies &amp; series, <em>fresh on OTT</em></h1>
    <p class="lead">A free Stremio addon with 8 catalogs that refresh every day: new Telugu releases, Tamil, Malayalam and Kannada films dubbed in Telugu, big English titles and Hindi picks, all streaming in India.</p>
    <div class="ctas">
      <a class="btn primary" href="stremio://${esc(host)}/manifest.json">Install in Stremio</a>
      <a class="btn" href="${esc(webInstall)}" target="_blank" rel="noopener">Use Stremio Web</a>
    </div>
    <div class="copy"><input id="murl" value="${esc(manifestUrl)}" readonly aria-label="Addon link"><button type="button" id="copybtn">Copy</button></div>
    <p class="hint">Button doesn't open Stremio? Copy the link and paste it into the search box on Stremio's Addons page.</p>
  </div>
</div>

${data.movies.length || data.series.length ? `<section><h2>New on OTT right now</h2>${strip("Telugu movies", data.movies)}${strip("Telugu series", data.series)}</section>` : ""}

<section><h2>Movie catalogs</h2><div class="grid">${cards(CATALOGS)}</div></section>
<section><h2>Series catalogs</h2><div class="grid">${cards(SERIES)}</div></section>

<section><h2>Platforms covered</h2><div class="chips">${PLATFORM_NAMES.map((p) => `<span>${esc(p)}</span>`).join("")}</div></section>

<section><h2>How to install</h2><ol class="steps">
  <li><b>Get Stremio.</b> It's free for Windows, Mac, Android, iPhone and Android TV at <a href="https://www.stremio.com/downloads" target="_blank" rel="noopener">stremio.com</a>.</li>
  <li><b>Press Install in Stremio</b> above, then <b>Install</b> in the window that opens.</li>
  <li><b>Open Board or Discover.</b> The TFI catalogs show up under Movies and Series.</li>
</ol></section>

<section><h2>Questions</h2>
<details><summary>Does TFI Movies play videos?</summary><p>No. It adds catalogs: posters, details, ratings and trailers for what's new on Indian OTT. It doesn't host or link to any video. Watch on the streaming service that has the title.</p></details>
<details><summary>How fresh are the catalogs?</summary><p>They update every morning (India time) from TMDB's streaming data, plus OTT release news from Sacnilk, 123telugu and 91mobiles, so new arrivals show up even before TMDB catches up.</p></details>
<details><summary>Do the dubbed catalogs have Telugu audio?</summary><p>Usually, but TMDB doesn't record audio languages, so it's a best guess. Check the language options on the streaming service.</p></details>
<details><summary>Is it free? Can I see how it works?</summary><p>Yes, it's free and needs no account. The code is open source on <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>.</p></details>
</section>

<footer>
  <p>TFI Movies v${esc(manifest(base).version)} · <a href="${REPO_URL}" target="_blank" rel="noopener">Source on GitHub</a></p>
  <p>Data from <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">TMDB</a>. This product uses the TMDB API but is not endorsed or certified by TMDB. Not affiliated with Stremio or any streaming service.</p>
</footer>
</div>
<script>
document.getElementById("copybtn").addEventListener("click", async function () {
  var b = this, i = document.getElementById("murl");
  try { await navigator.clipboard.writeText(i.value); } catch (e) { i.select(); document.execCommand("copy"); }
  b.textContent = "Copied!"; setTimeout(function () { b.textContent = "Copy"; }, 1600);
});
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
    if (path === "/" || path === "/configure") {
      const data = await Promise.race([landingData().catch(() => null), sleep(4000).then(() => null)]);
      return send(res, 200, landing(host, base, data || { lists: {}, movies: [], series: [] }), data ? 3600 : 300, "text/html; charset=utf-8");
    }
    if (path === "/manifest.json") return send(res, 200, manifest(base), 3600);
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
