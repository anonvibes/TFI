// News check: finds films and series newly released on Indian OTT from public release roundups
// (Sacnilk's OTT listing, 123telugu's OTT page, 91mobiles via a home server), so the lists don't depend only on
// TMDB's streaming data, which can lag by days or weeks for Indian titles.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const LANGS = {
  telugu: "te", tamil: "ta", malayalam: "ml", kannada: "kn", hindi: "hi", english: "en", bengali: "bn",
  marathi: "mr", odia: "or", oriya: "or", punjabi: "pa", gujarati: "gu", bhojpuri: "bho", assamese: "as",
};

// Platforms the lists cover (news spellings vary: "Zee 5", "Amazon Prime Video", "Jio Hotstar", "aha").
const PLATFORM_NAMES = [
  [/netflix/i, "Netflix"], [/prime|amazon/i, "Prime Video"], [/hotstar/i, "JioHotstar"], [/(^|[^a-z])aha([^a-z]|$)/i, "Aha"],
  [/zee ?5/i, "ZEE5"], [/sony ?liv/i, "SonyLIV"], [/sun ?nxt/i, "Sun NXT"], [/etv ?win/i, "ETV Win"],
];
export const platformOf = (s) => {
  for (const part of String(s || "").split(/,|\/|&|\band\b/i)) for (const [re, name] of PLATFORM_NAMES) if (re.test(part)) return name;
  return null;
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?";
const DATE_MDY = new RegExp(`^${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})$`, "i");
const DATE_DMY = new RegExp(`^(\\d{1,2})\\s+${MONTH},?\\s+(\\d{4})$`, "i");
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(s + "T00:00:00Z").getTime() + n * 864e5);

export function parseDate(s) {
  s = String(s || "").trim();
  let m = s.match(DATE_MDY);
  if (m) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(m[2])}`;
  m = s.match(DATE_DMY);
  if (m) return `${m[3]}-${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}-${pad(m[1])}`;
  return null;
}

// "Oct 23" (no year): assume this year, unless that is more than 60 days ahead (then it was last year).
export function parseShortDate(s, todayStr) {
  const m = String(s || "").match(new RegExp(`${MONTH}\\s*(\\d{1,2})`, "i"));
  if (!m) return null;
  const y = Number(todayStr.slice(0, 4));
  let d = `${y}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(m[2])}`;
  if (d > addDays(todayStr, 60)) d = `${y - 1}${d.slice(4)}`;
  return d;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", hellip: "…" };
export const decode = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const tokens = (html) => String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").split(/<[^>]*>/).map((t) => decode(t).replace(/\s+/g, " ").trim()).filter(Boolean);
const text = (html) => tokens(html).join(" ");

const langCode = (word) => LANGS[String(word || "").toLowerCase()] || null;
const langList = (s) => {
  const parts = String(s || "").split(/,|\band\b|&|\//i).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const codes = parts.map(langCode);
  return codes.every(Boolean) ? codes : null;
};

// ---- Sacnilk: https://www.sacnilk.com/ott-movie-releases?type=recent&time_period=all&page=N ----
// Each film is an <a href="/movie/<Title>_<Year>" data-platforms="Netflix" data-languages="Hindi, Tamil"> card,
// with the date ("Oct 23, 2026") in the poster overlay and the title in an <h3>.
const attr = (tag, name) => decode((String(tag).match(new RegExp(`\\b${name}="([^"]*)"`, "i")) || [])[1] || "").trim();
export function parseSacnilk(html) {
  const re = /(<a\b[^>]*\bhref="(?:https?:\/\/(?:www\.)?sacnilk\.com)?(\/movie\/[^"#?]+)"[^>]*>)([\s\S]*?)<\/a>/gi;
  const out = [];
  const seen = new Set();
  for (const [, tag, slug, body] of String(html).matchAll(re)) {
    if (seen.has(slug)) continue;
    const date = tokens(body).map(parseDate).find(Boolean);
    if (!date) continue;
    const slugTitle = decodeURIComponent(slug.replace(/^\/movie\//, "")).replace(/_(\d{4})$/, "").replace(/_/g, " ").trim();
    const yearHint = Number((slug.match(/_(\d{4})$/) || [])[1]) || null;
    const h3 = body.match(/<h3\b([^>]*)>([\s\S]*?)<\/h3>/i);
    // "Moana (3D)", "4 Idiots (Tamil)": the bracket is a format or dub note, not part of the title
    const title = ((h3 && (attr(h3[1], "title") || text(h3[2]))) || "").replace(/\s*\([^()]*\)\s*$/, "").trim() || slugTitle;
    const platform = attr(tag, "data-platforms") || attr((body.match(/<img\b[^>]*assets\/images\/[^>]*>/i) || [""])[0], "alt");
    seen.add(slug);
    out.push({ title, date, platform, langs: langList(attr(tag, "data-languages")) || [], origLang: null, type: "film", yearHint, source: "Sacnilk", ref: `https://www.sacnilk.com${slug}` });
  }
  return out;
}

// ---- 123telugu: https://www.123telugu.com/videos/ott ----
// Table rows: <td><a>Baththa (Tamil Film-Telugu Dub)</a><span class="t123-platform"> Netflix</span></td><td class="t123-date">Oct 29</td>
// (a separate platform cell, "Title | Netflix | Oct 29", is read too)
export function parse123telugu(html, todayStr) {
  const out = [];
  for (const row of String(html).match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = row.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
    if (cells.length < 2) continue;
    const span = cells[0].match(/<span\b[^>]*platform[^>]*>([\s\S]*?)<\/span>/i);
    const name = text(span ? cells[0].replace(span[0], " ") : cells[0]);
    const platform = span ? text(span[1]) : cells.length >= 3 ? text(cells[1]) : "";
    const m = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    const title = (m ? m[1] : name).trim();
    const info = m ? m[2] : "";
    const date = parseShortDate(text(cells[cells.length - 1]), todayStr);
    if (!title || !date) continue;
    // "Telugu Series", "English docuseries, Telugu dub"; "Hindi show" is a reality or talk show; "Episodes 3&4" is a weekly drop
    // of a series already listed; "Tamil Hit - Telugu Dub" is a film
    const type = /short/i.test(info) ? "short" : /episode/i.test(info) ? "episodes" : /series|season/i.test(info) ? "series"
      : /\bshow\b/i.test(info) ? "show" : /film|movie|\bhit\b/i.test(info) ? "film" : null;
    const first = (info.match(/^\s*([A-Za-z]+)/) || [])[1];
    out.push({ title, date, platform, langs: [], origLang: langCode(first), type, yearHint: null, source: "123telugu", ref: "https://www.123telugu.com/videos/ott" });
  }
  return out;
}

async function getText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ---- 91mobiles: https://www.91mobiles.com/entertainment/ott-release-this-week ----
// Cloudflare blocks servers, so a home server reads it daily into the public repo anonvibes/tfi-data.
// That file is written outside this app: keep only well-formed film and series entries.
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => (typeof v === "string" && v.length <= max ? v : null);
export function clean91mobiles(json) {
  const entries = (Array.isArray(json?.entries) ? json.entries : []).slice(0, 3000).flatMap((e) => {
    const title = str(e?.title, 150), date = str(e?.date, 10), ref = str(e?.ref, 300);
    if (!title || !date || !ISO.test(date) || !["film", "series"].includes(e.type) || !ref?.startsWith("https://www.91mobiles.com/entertainment/")) return [];
    const origLang = Object.values(LANGS).includes(e.origLang) ? e.origLang : null;
    return [{ title, date, platform: str(e.platform, 200) || "", langs: [], origLang, type: e.type, yearHint: null, source: "91mobiles", ref }];
  });
  return { changed: ISO.test(json?.changed) ? json.changed : null, entries };
}

// "Black Doves : Season 2", "Dhindora S1", "Chumbak Part 2", "Dupahiya 2" -> the show's name and the season
export function seasonOf(title) {
  const t = String(title || "").trim();
  let m = t.match(/^(.*?)\s*[:\-–(,]?\s*\b(?:season|s|part|chapter)\s*(\d{1,2})\)?$/i);
  if (m && m[1]) return { base: m[1].trim(), season: Number(m[2]) };
  m = t.match(/^(.*\D)\s+(\d{1,2})$/);
  if (m) return { base: m[1].trim(), season: Number(m[2]) };
  return { base: t, season: null };
}

// Recent OTT releases of one type ("film" or "series") from the news, cleaned and de-duplicated.
// 91mobiles' dates are exact, so they win. Sacnilk's listing has films only; leave sacnilkUrl out for series.
export async function fetchNews({ sacnilkUrl, teluguUrl, mobiles91Url, days = 120, pages = 6, todayStr, type = "film" }) {
  const from = addDays(todayStr, -days);
  const stats = { sacnilk: { pages: 0, rows: 0 }, telugu123: { rows: 0 }, mobiles91: { rows: 0 } };
  const raw = [];
  if (mobiles91Url) try {
    const { changed, entries } = clean91mobiles(JSON.parse(await getText(mobiles91Url)));
    stats.mobiles91 = { rows: entries.filter((e) => e.type === type).length, changed };
    raw.push(...entries);
  } catch (e) { stats.mobiles91.error = e.message; }
  if (!sacnilkUrl) delete stats.sacnilk;
  else try {
    for (let p = 1; p <= pages; p++) {
      const html = await getText(sacnilkUrl.replace("{page}", p));
      const rows = parseSacnilk(html);
      stats.sacnilk.pages = p; stats.sacnilk.rows += rows.length;
      if (p === 1) stats.sacnilk.sample = rows.slice(0, 3);
      if (!rows.length) { if (p === 1) stats.sacnilk.snippet = html.slice(html.indexOf("/movie/") - 200, html.indexOf("/movie/") + 600); break; }
      raw.push(...rows);
      if (rows.every((r) => r.date < from)) break;
    }
  } catch (e) { stats.sacnilk.error = e.message; }
  try {
    const rows = parse123telugu(await getText(teluguUrl), todayStr);
    stats.telugu123.rows = rows.filter((r) => r.type === type).length; stats.telugu123.sample = rows.filter((r) => r.type === type).slice(0, 3);
    raw.push(...rows);
  } catch (e) { stats.telugu123.error = e.message; }

  const byKey = new Map();
  for (const r of raw) {
    const platform = platformOf(r.platform);
    if (!platform || r.type !== type || r.date > todayStr || r.date < from) continue;
    const key = type === "series" ? (({ base, season }) => `${norm(base)}|${season || 1}`)(seasonOf(r.title)) : norm(r.title);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...r, platform, sources: [r.source] }); continue; }
    const prevExact = prev.sources.includes("91mobiles");
    if (r.source === "91mobiles" ? !prevExact : !prevExact && r.date < prev.date) { prev.date = r.date; prev.platform = platform; }
    prev.origLang ||= r.origLang;
    prev.yearHint ||= r.yearHint;
    if (!prev.langs.length) prev.langs = r.langs;
    if (!prev.sources.includes(r.source)) prev.sources.push(r.source);
  }
  return { entries: [...byKey.values()], stats };
}

// ---- Title matching ----
export function norm(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)/g, " ").replace(/&/g, "and").replace(/[^a-z0-9]/g, "")
    .replace(/aa+/g, "a").replace(/ee+/g, "i").replace(/ii+/g, "i").replace(/oo+/g, "u").replace(/uu+/g, "u")
    .replace(/th/g, "t").replace(/dh/g, "d").replace(/bh/g, "b").replace(/kh/g, "k").replace(/ph/g, "f").replace(/v/g, "w");
}
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  const ga = grams(a), gb = grams(b);
  let inter = 0;
  for (const [k, n] of ga) inter += Math.min(n, gb.get(k) || 0);
  return (2 * inter) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
}

// "Dahaan: The Evil Within" -> "Dahaan"
export const mainTitle = (s) => String(s || "").split(/\s*(?::|\s[-–—]\s)\s*/)[0];

// Other ways to search for a title TMDB spells differently: without the subtitle, with "aa" as "a",
// and the first half of the first word (TMDB matches word beginnings, so "Rakkasa" finds "Rakkasapuradhol").
export function searchVariants(title) {
  const main = mainTitle(title).trim();
  const first = main.split(/\s+/)[0];
  const prefix = first.length >= 7 ? first.slice(0, Math.max(5, Math.ceil(first.length * 0.5))) : first;
  return [...new Set([main, main.replace(/aa/gi, "a"), prefix])].filter((q) => q.length >= 4 && q !== title);
}

// Match each news entry to one TMDB film. Only clear, single matches are used; the rest go to review.
export async function matchNews(entries, { tmdb, mapLimit, concurrency = 6 }) {
  const matched = [], unsure = [], notFound = [];
  await mapLimit(entries, concurrency, async (e) => {
    const search = async (query) => (await tmdb("/search/movie", { query, include_adult: false })).results || [];
    let results = [];
    try { results = await search(e.title); }
    catch { unsure.push({ ...e, reason: "TMDB search failed", options: [] }); return; }
    const want = norm(e.title), wantMain = norm(mainTitle(e.title));
    const nums = (s) => (String(s || "").replace(/\([^)]*\)/g, "").match(/\d+/g) || []).join(" ");
    const score = (r) => Math.max(
      similarity(want, norm(r.title)), similarity(want, norm(r.original_title)),
      // titles that only agree once a subtitle is dropped count a little less than a full match
      0.95 * Math.max(similarity(wantMain, norm(mainTitle(r.title))), similarity(wantMain, norm(mainTitle(r.original_title)))))
      // a different number is usually a different film in a series ("Khalifa 2" is not "Khalifa")
      * ([r.title, r.original_title].some((t) => nums(t) === nums(e.title)) ? 1 : 0.85);
    const assess = (list) => {
      const seen = new Set();
      return list.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => {
        const rd = r.release_date || "";
        return {
          r, score: score(r),
          langOk: e.origLang ? r.original_language === e.origLang : e.langs.length ? e.langs.includes(r.original_language) : true,
          dateOk: rd && rd <= addDays(e.date, 30) && rd >= addDays(e.date, -3 * 365),
          yearGap: e.yearHint && rd ? Math.abs(Number(rd.slice(0, 4)) - e.yearHint) : 0,
          sameYear: !!(e.yearHint && rd && Number(rd.slice(0, 4)) === e.yearHint),
        };
      }).filter((c) => c.score >= 0.8 && c.dateOk);
    };
    const choose = (all) => {
      const cands = all.filter((c) => c.langOk);
      const exact = cands.filter((c) => c.score === 1);
      const strong = cands.filter((c) => c.score >= 0.9);
      if (exact.length === 1) return { pick: exact[0], cands };
      if (exact.length > 1) {
        exact.sort((a, b) => a.yearGap - b.yearGap);
        return { pick: e.yearHint && exact[0].yearGap < exact[1].yearGap ? exact[0] : null, cands };
      }
      if (strong.length === 1 && (e.origLang || e.langs.length)) return { pick: strong[0], cands };
      // Sacnilk's language list is the audio tracks, which can leave out the original language
      // (an English film listed as Hindi). Accept an exact title from the same year in any language.
      if (!cands.length && !e.origLang) {
        const anyLang = all.filter((c) => c.score === 1 && c.sameYear);
        if (anyLang.length === 1) return { pick: anyLang[0], cands: anyLang };
      }
      return { pick: null, cands };
    };
    let all = assess(results);
    let { pick, cands } = choose(all);
    if (!pick && !cands.length) {
      for (const q of searchVariants(e.title)) {
        try { all = assess([...all.map((c) => c.r), ...(await search(q))]); } catch { continue; }
        ({ pick, cands } = choose(all));
        if (pick || cands.length) break;
      }
    }
    const option = (c) => ({ id: c.r.id, title: c.r.title, date: c.r.release_date, lang: c.r.original_language });
    if (pick) matched.push({ id: pick.r.id, title: e.title, tmdbTitle: pick.r.title, lang: pick.r.original_language, platform: e.platform, date: e.date, sources: e.sources, ref: e.ref });
    else if (cands.length) unsure.push({ ...e, reason: "more than one possible TMDB film", options: cands.slice(0, 3).map(option) });
    else notFound.push({ ...e, reason: "no matching film on TMDB" });
  });
  const byDate = (a, b) => b.date.localeCompare(a.date);
  return { matched: matched.sort(byDate), unsure: unsure.sort(byDate), notFound: notFound.sort(byDate) };
}

// Match each series in the news to one TMDB show, the same way as films. A new season ("Season 2", "S2", "Part 2",
// a trailing "2") may belong to an old show, so only entries without a season need a show that started recently.
export async function matchSeriesNews(entries, { tmdb, mapLimit, concurrency = 6 }) {
  const matched = [], unsure = [], notFound = [];
  await mapLimit(entries, concurrency, async (e) => {
    const { base, season } = seasonOf(e.title);
    const search = async (query) => (await tmdb("/search/tv", { query, include_adult: false })).results || [];
    const wants = [...new Set([norm(e.title), norm(base)])], wantMain = norm(mainTitle(base));
    const score = (r) => Math.max(...[r.name, r.original_name].flatMap((n) =>
      [...wants.map((w) => similarity(w, norm(n))), 0.95 * similarity(wantMain, norm(mainTitle(n)))]));
    const assess = (list) => {
      const seen = new Set();
      return list.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => {
        const fd = r.first_air_date || "";
        return {
          r, score: score(r),
          langOk: e.origLang ? r.original_language === e.origLang : e.langs.length ? e.langs.includes(r.original_language) : true,
          dateOk: fd && fd <= addDays(e.date, 30) && (season >= 2 || fd >= addDays(e.date, -2 * 365)),
        };
      }).filter((c) => c.score >= 0.8 && c.dateOk);
    };
    const choose = (all) => {
      const cands = all.filter((c) => c.langOk);
      const exact = cands.filter((c) => c.score === 1);
      const strong = cands.filter((c) => c.score >= 0.9);
      if (exact.length === 1) return { pick: exact[0], cands };
      if (!exact.length && strong.length === 1 && (e.origLang || e.langs.length)) return { pick: strong[0], cands };
      return { pick: null, cands };
    };
    let all = [], pick = null, cands = [];
    for (const q of [...new Set([e.title, base, ...searchVariants(base)])]) {
      try { all = assess([...all.map((c) => c.r), ...(await search(q))]); }
      catch { if (q === e.title) { unsure.push({ ...e, reason: "TMDB search failed", options: [] }); return; } continue; }
      ({ pick, cands } = choose(all));
      if (pick || cands.length) break;
    }
    const option = (c) => ({ id: c.r.id, title: c.r.name, date: c.r.first_air_date, lang: c.r.original_language });
    if (pick) matched.push({ id: pick.r.id, title: e.title, tmdbTitle: pick.r.name, lang: pick.r.original_language, season, platform: e.platform, date: e.date, sources: e.sources, ref: e.ref });
    else if (cands.length) unsure.push({ ...e, reason: "more than one possible TMDB series", options: cands.slice(0, 3).map(option) });
    else notFound.push({ ...e, reason: "no matching series on TMDB" });
  });
  const byDate = (a, b) => b.date.localeCompare(a.date);
  return { matched: matched.sort(byDate), unsure: unsure.sort(byDate), notFound: notFound.sort(byDate) };
}

// ---- Layer 2: popular films in Indian cinemas 4–10 weeks ago that aren't in any list yet ----
export async function possiblyMissing({ tmdb, groups, exclude, todayStr, perGroup = 8, isCovered }) {
  const out = [];
  for (const g of groups) {
    try {
      const d = await tmdb("/discover/movie", {
        with_original_language: g.langs.join("|"), region: "IN", with_release_type: "2|3",
        "release_date.gte": addDays(todayStr, -75), "release_date.lte": addDays(todayStr, -28),
        sort_by: "popularity.desc", include_adult: false, page: 1,
      });
      let films = (d.results || []).filter((m) => !exclude.has(m.id)).slice(0, perGroup * 2);
      // skip films TMDB already shows as streaming (they're covered, just ranked lower than the list's top 100)
      if (isCovered) { const c = await Promise.all(films.map((m) => isCovered(m.id).catch(() => false))); films = films.filter((_, i) => !c[i]); }
      films = films.slice(0, perGroup);
      out.push(...films.map((m) => ({ id: m.id, title: m.title, lang: m.original_language, group: g.label, cinema: m.release_date, popularity: m.popularity })));
    } catch (e) { out.push({ group: g.label, error: e.message }); }
  }
  return out;
}

// ---- Review page ----
export function reviewHtml({ news, missing, inLists, generatedAt, esc }) {
  const tmdbLink = (id, t) => `<a href="https://www.themoviedb.org/movie/${id}">${esc(t)}</a>`;
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  const table = (head, rows) => rows.length ? `<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows.join("")}</table>` : `<p class="mut">Nothing here right now.</p>`;
  const src = (e) => `<a href="${esc(e.ref)}">${esc((e.sources || [e.source]).join(", "))}</a>`;
  const miss = missing.filter((m) => m.id);
  return `<h1>TFI Movies · Review</h1><p class="mut">Generated ${esc(generatedAt)}. Nothing on this page changes your lists; it lists what may need a look.</p>
<h2>Possibly missing</h2><p>Popular films that were in Indian cinemas 4–10 weeks ago but aren't in any list. Most of these reach OTT in that window; if one is streaming, TMDB is probably missing its Indian "Where to Watch" offer or digital release date.</p>
${table(["Film", "Language", "In cinemas"], miss.map((m) => row([tmdbLink(m.id, m.title), esc(m.lang), esc(m.cinema || "")])))}
<h2>In the news, but not matched to one TMDB film</h2><p>These were reported as new on OTT, but more than one TMDB film could fit, so they were left out.</p>
${table(["Title", "Platform", "OTT date", "Possible TMDB films", "Source"], news.unsure.map((e) => row([esc(e.title), esc(e.platform), esc(e.date), e.options.map((o) => `${tmdbLink(o.id, o.title)} (${esc(o.lang)}, ${esc(o.date || "?")})`).join("<br>") || "—", src(e)])))}
<h2>Matched from the news</h2><p>${news.matched.length} films reported as new on OTT were matched to TMDB. ✓ = in one of your lists now.</p>
${table(["Film", "Platform", "OTT date", "In a list"], news.matched.map((e) => row([tmdbLink(e.id, e.tmdbTitle), esc(e.platform), esc(e.date), inLists.has(e.id) ? "✓" : "—"])))}`;
}
