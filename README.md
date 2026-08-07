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
- **Status pill text, movies**: "Just Added" if the confirmed US digital/physical release date is within the last 7 days (`MOVIE_JUST_ADDED_WINDOW_DAYS`), "Now Streaming" from day 8 through day 14 (`MOVIE_NOW_STREAMING_WINDOW_DAYS`), and no pill at all past 14 days — a title that's been out a month doesn't need a freshness callout every time it shows up.
- **Status pill text, shows**: derived from `last_episode_to_air` / `status` / `seasons` on TMDB's `/tv/{id}` response (no extra API calls), only within `SHOW_RECENCY_WINDOW_DAYS` (7) of the relevant air date — past that, no pill:
  - **Premiere** — the show's season 1 has its own `air_date` within the window. Checked first, independently of `last_episode_to_air`, and takes priority over every other rule. This matters for Netflix-style drops where a whole first season releases the same day: `last_episode_to_air` would point at whichever episode aired last (episode 6, episode 8, whatever the season has), not episode 1, so checking `last_episode_to_air` alone would misread a brand-new show as a plain "New Episode". Checking season 1's own `air_date` catches it correctly, and also naturally covers the single-episode-season edge case (a TV movie, one-off special, or a show canceled after one episode — technically both the first and last episode of the last season, and should still read "Premiere", not "Finale").
  - **Finale &lt;date&gt;** — final episode of the final season, and the show's status is Ended/Canceled.
  - **New Season** — episode 1 of a season after the first (detected the same way as everything below this line, off `last_episode_to_air`, so a same-day binge-dropped *later* season can still land on "Season Finale" instead of "New Season" if its last released episode happens to be that season's final episode number — a narrower version of the Premiere issue above that wasn't in scope for this pass, worth a follow-up if it comes up in practice).
  - **Season Finale** — final episode of a season, but the show is still ongoing.
  - **New Episode** — any other recent episode.
  - All thresholds live in `lib/tmdb.js` near the top of the file.
- **Pill text sizing**: every pill uses the same fixed font size and letter-spacing rather than being sized per label, so a row of tags reads consistently regardless of which one shows up. The baseline size is derived from the longest label the app can produce — "Now Streaming" / "Season Finale" / a "Finale &lt;Mon&gt; &lt;DD&gt;" date are all 13 characters (`PILL_REFERENCE_CHAR_COUNT` in `lib/badge.js`) — sized to fill ~82% of the pill width at normal tracking (`PILL_TEXT_WIDTH_RATIO` / `AVG_CHAR_WIDTH_FACTOR`, calibrated against toptoday.llamayu.com's own "Just Added" rendering, pixel-measured at ~80% fill). `PILL_FONT_SCALE` (1.28) then bumps that up by request, and `PILL_LETTER_SPACING_RATIO` pulls the compact/tight tracking in to compensate, so the longest label ("Now Streaming") still fits with a few px of margin at the larger size — checked against all seven labels with no clipping. Shorter labels like "Premiere" just get more side margin at the same size, which is the intended look.
- **TMDB attribution**: the manifest description includes TMDB's required "This product uses the TMDB API but is not endorsed or certified by TMDB" notice, per their API Terms of Use.
- **btttr.cc outages**: if a poster fails to load from `btttr.cc`, `api/poster.js` automatically falls back to TMDB's own poster image so a catalog entry never shows a broken image.
- **Rank badge look**: built as an SVG (glossy white→gray gradient fill, dark bevel stroke, dual drop-shadow) rendered via `@resvg/resvg-js` with the bundled Inter Black font, then composited with `sharp`. Single- and double-digit ranks use the same font size and anchor point so "4" and "20" carry equal visual weight. Tweak the gradient stops / shadow values / `fontSize` in `lib/badge.js` if you want it lighter, darker, or a different size.
- **Status pill look**: a "liquid glass" treatment — an SVG rendered via `@resvg/resvg-js`, composited with `sharp`. The background is a blurred crop of the poster itself (`PILL_BLUR_SIGMA` = 14, taken from the exact region the pill covers) under a neutral, heavily see-through dark wash (`PILL_TINT` = black at `PILL_TINT_OPACITY` = 0.22, not tinted toward any one color so it reads well against light posters, dark posters, and anything in between), a soft white top-to-bottom sheen (`PILL_SHEEN_OPACITY`), a thin translucent white edge stroke (`PILL_BORDER_OPACITY`) so the panel still reads as a distinct glass element at that transparency, and a soft drop-shadow behind the text so it stays legible even over a light, busy background. Pill geometry (position, size, corner rounding) was pixel-measured directly off toptoday.llamayu.com's own output rather than eyeballed. All of the above are separate constants at the top of `lib/badge.js` if you want to tune the look further.
- This was verified end-to-end in a sandboxed test: real `sharp`/`resvg-js` rendering of both overlays against synthetic posters in light, dark, and mid-tone colors (correct geometry, one consistent font size and letter-spacing, no clipping across all seven status labels — checked by isolating and pixel-measuring just the text ink, since the pill's own decorative border/sheen touch the edges by design and would otherwise look like false clipping), and unit tests of the date/status logic (recency windows and gates, the Premiere-vs-Finale single-episode edge case, the Netflix whole-season-binge-drop Premiere case, series/season finale detection) against a range of scenarios. The live TMDB, `btttr.cc`, and Vercel deploy could not be exercised from that sandbox (network is restricted there), so double check the first deploy's catalogs load correctly in Stremio — if `TMDB_API_KEY` is wrong you'll see a 500 from `/catalog/...json`.
