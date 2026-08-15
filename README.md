# Top Charts Today (Stremio addon)

Two catalogs, ranked daily:

- **Top Movies Today** — top 20 US movies currently out digitally or on home release, ranked by trending activity (TMDB `trending/movie/day`, filtered to titles with a confirmed US digital or physical release date). Theatrical-only movies are excluded.
- **Top Shows Today** — top 20 shows from TMDB's daily trending list.

Each poster gets two overlays composited on top of the base image from `btttr.cc` (falls back to TMDB's own poster if `btttr.cc` doesn't have that title):

1. A glossy rank number inset in the top-left corner.
2. A bottom-flush status pill — a blurred, tinted crop of the poster itself behind a short label like "Just Added", "New Episode", or "Season Finale Aug 11" — modeled on toptoday.llamayu.com's bottom overlay style.

Every title's imdb_id is round-tripped through TMDB's `/find` endpoint before it's included, so a stale or mismatched cross-reference gets dropped instead of showing the wrong movie/show once you click into it in Stremio.

No cron jobs, no database. The catalog and poster endpoints set `Cache-Control: s-maxage=3600`, so Vercel's edge refreshes them automatically every hour. Zero maintenance once deployed.

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

- `GET /catalog/movie/top-movies-today.json` and `GET /catalog/series/top-shows-today.json` hit TMDB fresh on a cache miss, and Vercel's edge cache holds each response for 1 hour before quietly refetching in the background. Nothing to trigger manually.
- `GET /poster/:type/:imdb/:rank.jpg` renders the numbered poster + status pill on demand (also edge-cached).

## Project layout

```
api/
  manifest.js   -> /manifest.json
  catalog.js    -> /catalog/:type/:id.json
  poster.js     -> /poster/:type/:imdb/:rank.jpg
lib/
  tmdb.js       -> TMDB trending + imdb_id resolution + /find round-trip verification +
                    status label logic (Just Added / New Episode / Season Finale <date> / etc.)
  badge.js      -> renders the rank badge and status pill, composites both onto the poster
  cors.js       -> CORS headers required for Stremio to fetch these endpoints
assets/
  Inter-Bold.ttf   -> font used for the rank badge, status pill, and the icon (bundled so
                      rendering doesn't depend on fonts being installed on the server)
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
- **Status pill text, movies**: "Just Added" if the confirmed US digital/physical release date is within the last 7 days (`MOVIE_JUST_ADDED_WINDOW_DAYS`), "Now Streaming" from day 8 through day 14 (`MOVIE_NOW_STREAMING_WINDOW_DAYS`), and no pill at all past 14 days — a title that's been out a month doesn't need a freshness callout every time it shows up.
- **Status pill text, shows**: derived from `first_air_date` / `last_episode_to_air` / `next_episode_to_air` / `status` / `seasons` on TMDB's `/tv/{id}` response (no extra API calls):
  - **Coming Soon** — the show's first episode hasn't aired yet, and that premiere is less than `SHOW_COMING_SOON_WINDOW_DAYS` (7) days away. Beyond that window, no pill — a season announced months out doesn't need a callout yet.
  - **Premiere** — the show's season 1 has its own `air_date` within `SHOW_RECENCY_WINDOW_DAYS` (7) days in the past. Checked before the finale rules below and takes priority over every other rule. This matters for Netflix-style drops where a whole first season releases the same day: `last_episode_to_air` would point at whichever episode aired last (episode 6, episode 8, whatever the season has), not episode 1, so checking `last_episode_to_air` alone would misread a brand-new show as a plain "New Episode". Checking season 1's own `air_date` catches it correctly, and also naturally covers the single-episode-season edge case (a TV movie, one-off special, or a show canceled after one episode — technically both the first and last episode of the last season, and should still read "Premiere", not "Finale").
  - **New Season** — episode 1 of a season after the first (detected the same way as Premiere, off the season's own `air_date`, so a same-day binge-dropped *later* season can still land on "Season Finale" instead of "New Season" if its last released episode happens to be that season's final episode number — a narrower version of the Premiere issue above that wasn't in scope for this pass, worth a follow-up if it comes up in practice).
  - **Season Finale &lt;date&gt;** — the show's *upcoming* episode (`next_episode_to_air`) is the last episode of its season, airing within the next `SHOW_RECENCY_WINDOW_DAYS` (7) days. Shown with a date since it hasn't happened yet — a heads-up, not a recap. Always reads "Season Finale", never "Series Finale", even for what turns out to be the show's last-ever season: TMDB's `status` field only flips to Ended/Canceled after the finale actually airs, so there's no reliable signal beforehand that a season is also the series' last.
  - **Season Finale** (no date) — the finale already aired, within the past `SHOW_RECENCY_WINDOW_DAYS` (7) days, and the show is still ongoing. The date drops once it's already happened; it's reserved for the still-upcoming case above.
  - **Series Finale** (no date) — same as above, but the show's status is Ended/Canceled — i.e. it was in fact the last episode of the last season.
  - **New Episode** — any other recent episode, within the past `SHOW_RECENCY_WINDOW_DAYS` (7) days.
  - Past `SHOW_RECENCY_WINDOW_DAYS` on either side (too far in the future, or aired too long ago) — no pill.
  - Both finale checks skip single-episode seasons (`episode_count === 1`) — that's really a Premiere, not a Finale, same edge case as above.
  - All thresholds live in `lib/tmdb.js` near the top of the file.
- **Pill sizing**: the pill's width is dynamic, not fixed — it hugs each label's own rendered text width (measured directly via `resvg`'s bounding box, not estimated) plus fixed padding on each side (`PILL_PADDING_X_RATIO`, relative to pill height), capped at `PILL_MAX_WIDTH_RATIO` of the poster width as a safety limit. Short labels like "Premiere" get a narrow chip, long ones like "Now Streaming" get a wider one, both centered and flush with the bottom edge. Font size (`PILL_FONT_HEIGHT_RATIO`) and letter-spacing (`PILL_LETTER_SPACING_RATIO`) are both fixed ratios applied to every label the same way, so the text itself reads consistently across all seven tags — only the surrounding pill width changes.
- **TMDB attribution**: the manifest description includes TMDB's required "This product uses the TMDB API but is not endorsed or certified by TMDB" notice, per their API Terms of Use.
- **btttr.cc outages**: if a poster fails to load from `btttr.cc`, `api/poster.js` automatically falls back to TMDB's own poster image so a catalog entry never shows a broken image.
- **Catalog metadata**: each catalog entry also carries `description`, `genres`, `imdbRating`, and `runtime`, pulled straight from the TMDB movie/show details already fetched while resolving the item (`resolveMovie`/`resolveShow` in `lib/tmdb.js`, no extra API calls). This is so clients like Nuvio have full metadata immediately instead of depending on a separate meta addon resolving the imdb_id in time.
- **Rank badge look**: built as an SVG (glossy white→gray gradient fill, dark bevel stroke, dual drop-shadow) rendered via `@resvg/resvg-js` with the bundled Inter Black font, then composited with `sharp`. Single- and double-digit ranks use the same font size and anchor point so "4" and "20" carry equal visual weight. Tweak the gradient stops / shadow values / `fontSize` in `lib/badge.js` if you want it lighter, darker, or a different size.
- **Status pill look**: a "liquid glass" treatment — an SVG rendered via `@resvg/resvg-js`, composited with `sharp`. The background is a blurred crop of the poster itself (`PILL_BLUR_SIGMA` = 14, taken from the exact region the pill covers) under a neutral, very see-through dark wash (`PILL_TINT` = black at `PILL_TINT_OPACITY` = 0.15, not tinted toward any one color so it reads well against light posters, dark posters, and anything in between), a soft white top-to-bottom sheen (`PILL_SHEEN_OPACITY`), a thin translucent white edge stroke (`PILL_BORDER_OPACITY`) so the panel still reads as a distinct glass element at that transparency, and a soft drop-shadow behind the text so it stays legible even over a light, busy background. Pill height/corner rounding was pixel-measured directly off toptoday.llamayu.com's own output rather than eyeballed; width is dynamic (see Pill sizing above). All of the above are separate constants at the top of `lib/badge.js` if you want to tune the look further.
- This was verified end-to-end in a sandboxed test: real `sharp`/`resvg-js` rendering of both overlays against synthetic posters in light, dark, and mid-tone colors (correct dynamic-width geometry per label, one consistent font size and letter-spacing, visibly separated letterforms, noticeably lighter/more transparent tint than the previous pass), and unit tests of the date/status logic (recency windows and gates, the Premiere-vs-Finale single-episode edge case, the Netflix whole-season-binge-drop Premiere case, series/season finale detection) against a range of scenarios. The live TMDB, `btttr.cc`, and Vercel deploy could not be exercised from that sandbox (network is restricted there), so double check the first deploy's catalogs load correctly in Stremio — if `TMDB_API_KEY` is wrong you'll see a 500 from `/catalog/...json`.
