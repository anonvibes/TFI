# TFI Movies

<img src="tfi-logo.png" width="120" align="right" alt="TFI Movies logo">

A free Stremio addon with the latest Telugu movies and web series streaming on Indian OTT platforms, plus Telugu-dubbed, English and Hindi titles. Eight catalogs, refreshed automatically every day, also published as public TMDB lists.

**Install:** open [tfi-movies.vercel.app](https://tfi-movies.vercel.app) and press *Install in Stremio*, or paste `https://tfi-movies.vercel.app/manifest.json` into the search box on Stremio's Addons page.

TFI Movies only adds catalogs (posters, details, ratings and trailers). It doesn't host or link to any video.

## Movie lists

| List | What it shows |
|---|---|
| Latest Streaming - TFI | Telugu films streaming in India, latest OTT arrivals first |
| Latest Dubbed - TFI | Tamil, Malayalam and Kannada films streaming in India, latest OTT arrivals first |
| Latest English Dubbed - TFI | Well-known English films streaming in India, latest OTT arrivals first |
| Latest Streaming - Hindi | Hindi films streaming in India, latest OTT arrivals first |

Each list holds 100 films that are on Netflix, Prime Video, JioHotstar, Aha, ZEE5, SonyLIV, Sun NXT or ETV Win in India. Films that TMDB gives an Indian digital (OTT) release date in the last 120 days are included too, so new OTT arrivals show up before TMDB's "Where to Watch" catches up. Lists are ordered by when each film arrived on OTT in India (its Indian digital release date on TMDB), or by its main release date when TMDB doesn't have one.

- **News check:** each daily refresh also reads the OTT release listings on [Sacnilk](https://www.sacnilk.com/ott-movie-releases) and [123telugu](https://www.123telugu.com/videos/ott), plus [91mobiles](https://www.91mobiles.com/entertainment/ott-release-this-week) (it blocks servers, so a home server reads it daily at 5:00 IST into the public repo [anonvibes/tfi-data](https://github.com/anonvibes/tfi-data); its OTT dates win), matches each film to TMDB, and adds it to the right list using the OTT date from the news. This catches films TMDB hasn't marked as streaming yet. Only clear, single matches are added.
- **Review page:** [tfi-movies.vercel.app/review](https://tfi-movies.vercel.app/review) lists popular films that were in Indian cinemas 4–10 weeks ago but aren't in any list (possibly missing), plus news reports that couldn't be matched to one TMDB film. It never changes the lists.
- **Daily refresh:** Vercel runs `/sync` once a day, around 6–7 am IST. Opening `/sync?key=<CRON_SECRET>` runs it straight away and shows each list's link.

## Series lists

| List | What it shows |
|---|---|
| Latest Series - TFI | Telugu web series streaming in India |
| Latest Dubbed Series - TFI | Tamil, Malayalam and Kannada web series streaming in India |
| Latest English Series - TFI | Well-known English web series streaming in India |
| Latest Series - Hindi | Hindi web series streaming in India |

Each holds 100 series on the same platforms. A series is ranked by when its newest season started, so a new season of an older show comes up next to brand-new shows. Web series only: TV serials and daily soaps (any season longer than 40 episodes), reality shows, talk shows and news are left out, plus well-known reality franchises by name (Bigg Boss, Indian Idol, …), since TMDB lists some of them as scripted. Vercel runs `/sync-series` once a day, around 7–8 am IST; opening `/sync-series?key=<CRON_SECRET>` runs it straight away. The news check covers series too: series that 123telugu and 91mobiles report as new on OTT are matched to TMDB and added, which catches aha / ETV Win originals TMDB doesn't show as streaming. When the news reports a season TMDB doesn't have yet, the news date is used. Talk and reality shows ("Hindi show") and weekly episode drops in the news are ignored. Unmatched series are listed under `news` in the `/sync-series` result.

## Stremio addon

The addon shows the same eight catalogs (movies under Movies, series under Series): the first 100 titles in each come straight from the TMDB lists, and scrolling further loads older ones. Movies and series use IMDb IDs where they have one, so other Stremio addons (subtitles, for example) work with them as usual.

## Run your own copy

1. Fork this repo and import it into [Vercel](https://vercel.com) (free Hobby plan is enough).
2. Add `TMDB_API_KEY` (and `CRON_SECRET`, any long random text) under **Settings → Environment Variables**, then redeploy.
3. **One-time connection:** the sync edits lists through your TMDB account. Open `/tmdb-connect` on your deployment, approve on TMDB, and save the key it shows as `TMDB_USER_TOKEN` in Vercel. Once that's set, `/tmdb-connect` only works as `/tmdb-connect?key=<CRON_SECRET>`.
4. Open `/sync?key=<CRON_SECRET>` and `/sync-series?key=<CRON_SECRET>` once to create the lists. After that, Vercel's cron keeps them fresh.

**Lists are found by name.** Renaming a list on TMDB makes the next sync create a fresh one; deleting one does the same.

## Settings

Set these in Vercel under **Settings → Environment Variables**, then redeploy.

| Variable | Default | What it does |
|---|---|---|
| `TMDB_API_KEY` | — | Required. TMDB API key or Read Access Token |
| `TMDB_READ_TOKEN` | — | TMDB "API Read Access Token". Only needed for `/tmdb-connect` if `TMDB_API_KEY` is the short key |
| `TMDB_USER_TOKEN` | — | Lets the sync edit your lists. Created by `/tmdb-connect` |
| `LIST_SIZE` | `100` | Movies per list (max 500) |
| `DIGITAL_DAYS` | `120` | Also include films with an Indian digital release date in this many past days; `0` turns it off |
| `NEWS_CHECK` | `on` | `off` stops reading OTT release news |
| `CRON_SECRET` | — | Recommended. When set, `/sync` and `/sync-series` only run for Vercel's scheduler or with `?key=<secret>` |
| `META_LANGUAGE` | `en-US` | `te-IN` shows Telugu-script titles where TMDB has them |
| `DUB_SOURCE_LANGS` | `ta\|ml\|kn` | Languages in "Latest Dubbed - TFI"; add `\|hi` for Hindi |
| `DUB_MIN_VOTES` | `3` | Hides obscure titles from "Latest Dubbed - TFI" |
| `EN_DUB_MIN_VOTES` | `100` | Minimum TMDB votes for "Latest English Dubbed - TFI" |
| `HINDI_MIN_VOTES` | `0` | Set e.g. `5` to hide obscure Hindi titles |
| `MIN_RUNTIME` | `60` | Hides shorts (minutes); `0` turns it off |
| `DUB_SERIES_MIN_VOTES` | `0` | Minimum TMDB votes for "Latest Dubbed Series - TFI" |
| `EN_SERIES_MIN_VOTES` | `100` | Minimum TMDB votes for "Latest English Series - TFI" |
| `HINDI_SERIES_MIN_VOTES` | `0` | Minimum TMDB votes for "Latest Series - Hindi" |
| `SERIES_MAX_EPISODES` | `40` | A series with a longer season counts as a TV serial and is left out; `0` turns it off |
| `SERIES_SKIP_TITLES` | `bigg boss\|indian idol\|…` | Series whose names match are left out (reality and talk shows TMDB lists as scripted) |
| `CACHE_HOURS` | `6` | How often the addon's catalogs refresh |
| `WATCH_REGION` | `IN` | Streaming region |

## Good to know

- TMDB doesn't record audio languages, so the dubbed catalogs are a best guess: most films listed have Telugu audio, but not all.
- Films with no Indian digital release date on TMDB are placed by their main release date, so they can sit lower than they should. Films released more than a year ago always use their main release date, so old films newly added to a platform don't jump to the top.
- ETV Win-only films never appear, because TMDB's streaming data (from JustWatch) doesn't cover ETV Win.

## Files

| Path | Purpose |
|---|---|
| `api/index.js` | Movie and series list sync, review page, install page and Stremio addon |
| `lib/news.js` | Reads and matches OTT release news; the possibly-missing check |
| `lib/logo.js` | Addon logo (served at `/logo.png`) |
| `vercel.json` | Sends every request to `api/index.js`, and schedules the daily `/sync` and `/sync-series` |

---

This product uses the TMDB API but is not endorsed or certified by TMDB.
