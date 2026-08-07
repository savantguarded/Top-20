# Top Charts Today (Stremio addon)

Two catalogs, ranked daily:

- **Top Movies Today** — top 20 US movies currently out digitally or on home release, ranked by trending activity (TMDB `trending/movie/day`, filtered to titles with a confirmed US digital or physical release date). Theatrical-only movies are excluded.
- **Top Shows Today** — top 20 shows from TMDB's daily trending list.

Each poster gets two overlays composited on top of the base image from `btttr.cc` (falls back to TMDB's own poster if `btttr.cc` doesn't have that title):

1. A glossy rank number inset in the top-left corner.
2. A bottom-flush status pill — a blurred, tinted crop of the poster itself behind a short label like "Just Added", "New Episode", or "Season Finale" — modeled on toptoday.llamayu.com's bottom overlay style.

Every title's imdb_id is round-tripped through TMDB's `/find` endpoint before it's included, so a stale or mismatched cross-reference gets dropped instead of showing the wrong movie/show once you click into it in Stremio.

No cron jobs, no database. The catalog and poster endpoints set `Cache-Control: s-maxage=1800`, so Vercel's edge refreshes them automatically every 30 minutes. Zero maintenance once deployed.

## 1. Deploy

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New Project** → import that repo.
3. Under **Environment Variables**, add:
   - `TMDB_API_KEY` = your TMDB v3 API key
4. Deploy.

That's it — no build step, no other config needed.

## 2. Install in Stremio

Once deployed, your manifest URL is:

```
https://<your-project>.vercel.app/manifest.json
```

In Stremio: **Addons → search bar → paste that URL → Install**. The two catalogs will show up on the Discover/Board pages named "Top Movies Today" and "Top Shows Today".

## 3. How it updates

- `GET /catalog/movie/top-movies-today.json` and `GET /catalog/series/top-shows-today.json` hit TMDB fresh on a cache miss, and Vercel's edge cache holds each response for 30 minutes before quietly refetching in the background. Nothing to trigger manually.
- `GET /poster/:type/:imdb/:rank.jpg` renders the numbered poster + status pill on demand (also edge-cached).

## Project layout

```
api/
  manifest.js   -> /manifest.json
  catalog.js    -> /catalog/:type/:id.json
  poster.js     -> /poster/:type/:imdb/:rank.jpg
lib/
  tmdb.js       -> TMDB trending + imdb_id resolution + /find round-trip verification +
                    status label logic (Just Added / New Episode / Season Finale / etc.)
  badge.js      -> renders the rank badge and status pill, composites both onto the poster
  cors.js       -> CORS headers required for Stremio to fetch these endpoints
assets/
  Inter-Black.ttf  -> font used for the rank badge and the icon (bundled so rendering
                      doesn't depend on fonts being installed on the server)
scripts/
  generate-icon.js -> one-off script that rendered icon.png (re-run only if you want
                       to redesign the icon; it's a static file otherwise, no runtime cost)
icon.png        -> addon logo shown in Stremio's addon list, served as a plain static file
vercel.json     -> maps the clean Stremio-protocol URLs to the api/ functions
```

## Notes / things worth knowing

- **Region**: hardcoded to `US` in `lib/tmdb.js`. Change the `region`/US filters there if you ever want a different market.
- **"Digital or home release"**: TMDB release type `4` = Digital, `5` = Physical (per TMDB's own docs: 1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital, 5 Physical, 6 TV). Movies are pulled from `trending/movie/day` (so the list actually changes day to day) and then checked against each title's `release_dates` to confirm a US digital/physical date exists and has already passed. If you also want to include limited theatrical re-releases or premiere dates, adjust the filter in `usDigitalReleaseDate()` in `lib/tmdb.js`.
- **ID accuracy**: for every candidate, `lib/tmdb.js` calls `/find/{imdb_id}` and confirms it resolves back to the same TMDB id with a matching (or near-matching, accents/subtitle-tolerant) title before including it. Anything that fails this check is silently dropped rather than risking a wrong title showing up when you open it in Stremio.
- **Always a full 20**: `trending/day` is a raw popularity feed — it doesn't know or care whether a movie is out digitally yet. Rather than pulling one fixed-size pool and hoping enough of it survives the digital/physical filter (which was the earlier bottleneck — a fixed pool of 30 trending movies could lose more than 10 to still-in-theaters titles on a busy release week, leaving the catalog short), `collectUntilFilled()` in `lib/tmdb.js` pages through trending results in order and keeps requesting more pages until 20 titles pass every check, or `MAX_PAGES` (6, ~120 raw candidates) is hit. If TMDB ever has fewer than 20 valid, verified, digitally-released candidates within that many pages, you'll get however many pass instead of a hard failure. Bump `MAX_PAGES` in `lib/tmdb.js` if you want it to search deeper (at the cost of a slower response on a cache miss).
- **Status pill text**: for movies it's "Just Added" if the confirmed US digital/physical release date is within the last 7 days, otherwise "Now Streaming". For shows it's derived from `last_episode_to_air` / `status` / `seasons` on TMDB's `/tv/{id}` response (no extra API calls): "Premiere" (season 1 episode 1, aired within 7 days), "New Season" (episode 1 of a later season), "Finale <date>" (final episode of the final season, show status Ended/Canceled), "Season Finale" (final episode of a season, show still ongoing), "New Episode" (any other recent episode), or "Now Streaming" as the fallback when nothing recent happened. All thresholds live in `RECENCY_WINDOW_DAYS` in `lib/tmdb.js`.
- **Pill text sizing**: font size is computed per label so the text fills a consistent ~82% of the pill width (`PILL_TEXT_WIDTH_RATIO` / `AVG_CHAR_WIDTH_FACTOR` in `lib/badge.js`), clamped between `PILL_FONT_MIN_RATIO` and `PILL_FONT_MAX_RATIO` of the pill height. This was calibrated against toptoday.llamayu.com's own "Just Added" rendering (pixel-measured at ~80% fill) rather than a fixed size, so short labels ("Premiere") render large and long ones ("Finale Aug 7") shrink just enough to fit without overflowing the pill.
- **TMDB attribution**: the manifest description includes TMDB's required "This product uses the TMDB API but is not endorsed or certified by TMDB" notice, per their API Terms of Use.
- **btttr.cc outages**: if a poster fails to load from `btttr.cc`, `api/poster.js` automatically falls back to TMDB's own poster image so a catalog entry never shows a broken image.
- **Rank badge look**: built as an SVG (glossy white→gray gradient fill, dark bevel stroke, dual drop-shadow) rendered via `@resvg/resvg-js` with the bundled Inter Black font, then composited with `sharp`. Single- and double-digit ranks use the same font size and anchor point so "4" and "20" carry equal visual weight. Tweak the gradient stops / shadow values / `fontSize` in `lib/badge.js` if you want it lighter, darker, or a different size.
- **Status pill look**: also an SVG rendered via `@resvg/resvg-js`, composited with `sharp`. The background is a blurred crop of the poster itself (taken from the exact region the pill covers) with a dark maroon tint over it, so it always matches the poster it's on rather than using a flat color. Geometry (position, size, corner rounding) was pixel-measured directly off toptoday.llamayu.com's own output rather than eyeballed. Tweak `PILL_TINT`, `PILL_BLUR_SIGMA`, or the `PILL_*_RATIO` constants in `lib/badge.js` to adjust.
- This was verified end-to-end in a sandboxed test: real `sharp`/`resvg-js` rendering of both overlays against a synthetic poster (correct geometry, no overflow across all seven status labels), and unit tests of the date/status logic (recency windows, premiere/season-finale/series-finale detection) against a range of scenarios. The live TMDB, `btttr.cc`, and Vercel deploy could not be exercised from that sandbox (network is restricted there), so double check the first deploy's catalogs load correctly in Stremio — if `TMDB_API_KEY` is wrong you'll see a 500 from `/catalog/...json`.
