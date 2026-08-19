# Top Charts Today (Stremio addon)

Two catalogs, ranked daily:

- **Top Movies Today** — top 20 US movies currently out digitally or on home release, ranked by trending activity (TMDB `trending/movie/day`, filtered to titles with a confirmed US digital or physical release date). Theatrical-only movies are excluded.
- **Top Shows Today** — top 20 shows from TMDB's daily trending list, filtered to shows that have already aired at least one episode or premiere within the next 7 days. A show trending purely on announcement buzz months ahead of its premiere doesn't take a slot.

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

## 4. Live config (change settings without a redeploy)

A handful of settings — which site posters come from, the region used for release checks, how big each catalog is, and the day-windows behind each status label — are read from **Vercel Edge Config**, a free key-value store built into Vercel. Change a value there and it takes effect for new requests within a few seconds: no code edit, no GitHub push, no redeploy, no cost on Vercel's free (Hobby) tier at this addon's traffic level.

You don't have to set this up — everything works with the built-in defaults (btttr.cc posters, US region, 20 items per catalog, the same status-label windows described below) until you do.

There are two ways to actually change a value: a settings web page (`/config`, recommended — a plain form, no JSON, no Vercel dashboard) or editing Edge Config's raw JSON by hand in Vercel's dashboard. Both write to the same place; use whichever's more convenient at the time.

**One-time setup (do this once, needs one redeploy):**

1. In the Vercel dashboard, open this project → **Storage** tab → **Create Database** → choose **Edge Config** → create it and **connect** it to this project. Vercel adds an `EDGE_CONFIG` environment variable for you automatically — nothing to type in yourself.
2. To get the `/config` settings page working (skip this step if you only ever want to edit Edge Config's raw JSON by hand instead):
   - Create a Vercel API token: click your avatar (top right) → **Settings** → **Tokens** → **Create Token**. Name it anything (e.g. "top20-config-writer"), leave the scope as your account, no need to set an expiry unless you want one. **Copy the token immediately** — Vercel only shows it once.
   - In this project's **Settings** → **Environment Variables**, add:
     - `VERCEL_API_TOKEN` = the token you just copied
     - `CONFIG_PASSWORD` = any password you make up — this is what protects the settings page, since anyone with the URL could otherwise change your addon
   - If this Vercel project lives under a **Team** rather than your personal account, also add `VERCEL_TEAM_ID` (found in Team Settings → General → Team ID). Most personal setups don't need this.
3. Redeploy once (Vercel usually redeploys automatically after you connect Edge Config or add environment variables; if not, trigger one from the **Deployments** tab). After this, every future value change is instant — no more redeploys.
4. Visit `https://<your-project>.vercel.app/config?key=<your CONFIG_PASSWORD>` and bookmark that exact URL. That's your settings page from now on — a form with every tunable setting, pre-filled with the current values. Change what you want and click **Save changes**; it takes effect within a few seconds. **Reset all to defaults** clears every override in one click.

Prefer editing raw JSON instead? Skip the token/password steps above and just open the Edge Config store's **Items** tab → **Add Item** → key `topTwentyConfig`, value a JSON object with the setting(s) you want to override, e.g. `{ "posterUrlTemplate": "https://btttr.cc/poster-n/imdb/poster-default/{imdbId}.jpg?tag=none" }`. Edit that same item any time, no redeploy.

**What each setting does** (all optional — anything you leave out, or leave blank on the form, keeps its default):

| Key | Default | What it does |
| --- | --- | --- |
| `posterUrlTemplate` | btttr.cc URL (see `lib/config.js`) | Base poster image source. `{imdbId}` is replaced with the title's IMDb id. Point this at any imdb-keyed poster URL — TMDB's own poster stays the automatic fallback if this one 404s. |
| `region` | `"US"` | Country code used to check digital/physical release dates and show premieres. |
| `catalogSize` | `20` | How many items each catalog tries to fill to. |
| `maxPages` | `6` | Safety cap on how many pages of TMDB's trending list to search while filling the catalog. |
| `foreignMinVoteCount` | `50` | Minimum TMDB vote count for a non-English trending title to be considered. |
| `movie.justAddedWindowDays` | `3` | "Just Added" pill window after digital release. |
| `movie.nowStreamingWindowDays` | `14` | "Now Streaming" pill window after digital release. |
| `movie.blurayWindowDays` | `7` | "Now on Blu-ray" pill window after physical release. |
| `movie.comingSoonWindowDays` | `3` | "Coming Soon" pill window before digital release. |
| `show.recencyWindowDays` | `7` | How long episode-based show pills (Premiere/New Season/New Episode/Finale) stay visible. |
| `show.comingSoonWindowDays` | `7` | How far ahead of premiere a show gets a "Coming Soon" pill / counts as eligible at all. |

Raw-JSON example overriding a few things at once (the `/config` page does the equivalent for you, field by field):

```json
{
  "posterUrlTemplate": "https://api.ratingposterdb.com/YOUR-RPDB-KEY/imdb/poster-default/{imdbId}.jpg?fallback=true",
  "catalogSize": 15,
  "movie": { "nowStreamingWindowDays": 21 }
}
```

If Edge Config is ever unreachable (or you never set any of this up), `lib/config.js` falls back to the built-in defaults automatically — a bad or missing value there never breaks the addon. Same goes for `/config` itself: if `CONFIG_PASSWORD` isn't set yet, the page just explains that instead of erroring.

## Project layout

```
api/
  manifest.js   -> /manifest.json
  catalog.js    -> /catalog/:type/:id.json
  poster.js     -> /poster/:type/:imdb/:rank.jpg
  config.js     -> /config -- password-protected settings web page, see "Live config" above
lib/
  tmdb.js       -> TMDB trending + imdb_id resolution + /find round-trip verification +
                    status label logic (Just Added / New Episode / Season Finale <date> / etc.)
  config.js     -> runtime-tunable settings (poster provider, region, catalog size, status
                    label windows), read from Vercel Edge Config with built-in defaults --
                    see "Live config" above
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

- **Region**: `US` by default, read from `lib/config.js` — override live via Edge Config's `region` key (see "Live config" above) if you ever want a different market. No code change needed.
- **"Digital or home release"**: TMDB release type `4` = Digital, `5` = Physical (per TMDB's own docs: 1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital, 5 Physical, 6 TV). Movies are pulled from `trending/movie/day` (so the list actually changes day to day) and then checked against each title's `release_dates` to confirm a digital/physical date in the configured region exists and has already passed. If you also want to include limited theatrical re-releases or premiere dates, adjust the filter in `regionDigitalReleaseDate()` in `lib/tmdb.js` (this one's a code change, not a live-config option).
- **ID accuracy**: for every candidate, `lib/tmdb.js` calls `/find/{imdb_id}` and confirms it resolves back to the same TMDB id with a matching (or near-matching, accents/subtitle-tolerant) title before including it. Anything that fails this check is silently dropped rather than risking a wrong title showing up when you open it in Stremio.
- **Always a full catalog**: `trending/day` is a raw popularity feed — it doesn't know or care whether a movie is out digitally yet. Rather than pulling one fixed-size pool and hoping enough of it survives the digital/physical filter (which was the earlier bottleneck — a fixed pool of 30 trending movies could lose more than 10 to still-in-theaters titles on a busy release week, leaving the catalog short), `collectUntilFilled()` in `lib/tmdb.js` pages through trending results in order and keeps requesting more pages until `catalogSize` titles pass every check, or `maxPages` (default 6, ~120 raw candidates) is hit. If TMDB ever has fewer than `catalogSize` valid, verified, digitally-released candidates within that many pages, you'll get however many pass instead of a hard failure. Both `catalogSize` and `maxPages` are live-config keys (see above) — bump `maxPages` if you want it to search deeper (at the cost of a slower response on a cache miss).
- **Show eligibility**: `trending/tv/day` can surface a show purely on announcement/casting buzz, sometimes months before it premieres. `isShowEligible()` in `lib/tmdb.js` excludes anything that hasn't aired at least one episode and isn't premiering within `show.comingSoonWindowDays` (default 7) days — same mechanism as the movie eligibility filter above, and it feeds the same `collectUntilFilled()` paging loop, so an excluded show is simply replaced by the next trending show that qualifies.
- **Status pill text, movies**: "Just Added" if the confirmed release date (in the configured region) is within the last `movie.justAddedWindowDays` days (default 3), "Now Streaming" through `movie.nowStreamingWindowDays` (default 14), and no pill past that — a title that's been out a month doesn't need a freshness callout every time it shows up. All four movie windows are live-config keys, see "Live config" above.
- **Status pill text, shows**: derived from `first_air_date` / `last_episode_to_air` / `next_episode_to_air` / `status` / `seasons` on TMDB's `/tv/{id}` response (no extra API calls). Both show windows (`show.recencyWindowDays`, `show.comingSoonWindowDays`, both default 7) are live-config keys:
  - **Coming Soon** — the show's first episode hasn't aired yet, and that premiere is less than `show.comingSoonWindowDays` away. Beyond that window, no pill — a season announced months out doesn't need a callout yet.
  - **Premiere** — the show's season 1 has its own `air_date` within `show.recencyWindowDays` in the past. Checked before the finale rules below and takes priority over every other rule. This matters for Netflix-style drops where a whole first season releases the same day: `last_episode_to_air` would point at whichever episode aired last (episode 6, episode 8, whatever the season has), not episode 1, so checking `last_episode_to_air` alone would misread a brand-new show as a plain "New Episode". Checking season 1's own `air_date` catches it correctly, and also naturally covers the single-episode-season edge case (a TV movie, one-off special, or a show canceled after one episode — technically both the first and last episode of the last season, and should still read "Premiere", not "Finale").
  - **New Season** — episode 1 of a season after the first (detected the same way as Premiere, off the season's own `air_date`, so a same-day binge-dropped *later* season can still land on "Season Finale" instead of "New Season" if its last released episode happens to be that season's final episode number — a narrower version of the Premiere issue above that wasn't in scope for this pass, worth a follow-up if it comes up in practice).
  - **Season Finale &lt;date&gt;** — the show's *upcoming* episode (`next_episode_to_air`) is the last episode of its season, airing within the next `show.recencyWindowDays`. Shown with a date since it hasn't happened yet — a heads-up, not a recap. Always reads "Season Finale", never "Series Finale", even for what turns out to be the show's last-ever season: TMDB's `status` field only flips to Ended/Canceled after the finale actually airs, so there's no reliable signal beforehand that a season is also the series' last.
  - **Season Finale** (no date) — the finale already aired, within the past `show.recencyWindowDays`, and the show is still ongoing. The date drops once it's already happened; it's reserved for the still-upcoming case above.
  - **Series Finale** (no date) — same as above, but the show's status is Ended/Canceled — i.e. it was in fact the last episode of the last season.
  - **New Episode** — any other recent episode, within `show.recencyWindowDays`.
  - Past `show.recencyWindowDays` on either side (too far in the future, or aired too long ago) — no pill.
  - Both finale checks skip single-episode seasons (`episode_count === 1`) — that's really a Premiere, not a Finale, same edge case as above.
- **Pill sizing**: the pill's width is dynamic, not fixed — it hugs each label's own rendered text width (measured directly via `resvg`'s bounding box, not estimated) plus fixed padding on each side (`PILL_PADDING_X_RATIO`, relative to pill height), capped at `PILL_MAX_WIDTH_RATIO` of the poster width as a safety limit. Short labels like "Premiere" get a narrow chip, long ones like "Now Streaming" get a wider one, both centered and flush with the bottom edge. Font size (`PILL_FONT_HEIGHT_RATIO`) and letter-spacing (`PILL_LETTER_SPACING_RATIO`) are both fixed ratios applied to every label the same way, so the text itself reads consistently across all seven tags — only the surrounding pill width changes.
- **TMDB attribution**: the manifest description includes TMDB's required "This product uses the TMDB API but is not endorsed or certified by TMDB" notice, per their API Terms of Use.
- **Poster provider outages**: if a poster fails to load from the configured provider (btttr.cc by default — see "Live config" above to swap it), `api/poster.js` automatically falls back to TMDB's own poster image so a catalog entry never shows a broken image.
- **Catalog metadata is deliberately minimal**: each entry is just `id`, `type`, `name`, `poster`, `background`, `releaseInfo` — no `description`/`genres`/`imdbRating`/`runtime`/`logo`. Earlier versions included those too, so clients like Nuvio would have something to show without a separate meta addon, but once a real metadata addon (e.g. aiometadata) is installed, an over-full catalog preview competes with it instead of deferring to it. This addon only declares `resources: ['catalog']` in `api/manifest.js` — it was never meant to supply full meta, so it stays out of aiometadata's way and lets it own description/genres/rating/runtime/logo on the actual detail page.
- **`background`**: a plain TMDB backdrop (`details.backdrop_path`, already fetched alongside every candidate's other details — no extra API call), no overlay. This exists specifically for Nuvio's home-screen hero carousel and any landscape-mode catalog card: without a `background`/`banner` field, those fall back to stretching `poster` to hero width instead — and since `poster` has the rank badge burned into its top-left corner (see below), that fallback blew the badge number up into a huge, wrong-looking hero image. `background` only affects Nuvio's home-screen tiles; the real per-title background/logo on the actual detail page is still 100% aiometadata's, unaffected by anything in this repo.
- **Home-screen logo**: Nuvio's hero/landscape cards also support a `logo` field, but it's sourced *only* from whichever catalog embeds it directly — there's no fallback to a separate meta addon for that specific screen. This addon doesn't supply one (kept out of aiometadata's territory), so titles from these catalogs show a plain text title there instead of a logo. If you want your own catalog excluded from Nuvio's hero rotation entirely (so only catalogs that do supply logos appear there), toggle "Hero source" off for both catalogs under Nuvio's Home Screen settings.
- **Rank badge look**: built as an SVG (glossy white→gray gradient fill, dark bevel stroke, dual drop-shadow) rendered via `@resvg/resvg-js` with the bundled Inter Bold font, then composited with `sharp`. Single- and double-digit ranks use the same font size and anchor point so "4" and "20" carry equal visual weight. Tweak the gradient stops / shadow values / `fontSize` in `lib/badge.js` if you want it lighter, darker, or a different size.
- **Status pill look**: a "liquid glass" treatment — an SVG rendered via `@resvg/resvg-js`, composited with `sharp`. The background is a blurred crop of the poster itself (`PILL_BLUR_SIGMA` = 14, taken from the exact region the pill covers) under a neutral, very see-through dark wash (`PILL_TINT` = black at `PILL_TINT_OPACITY` = 0.15, not tinted toward any one color so it reads well against light posters, dark posters, and anything in between), a soft white top-to-bottom sheen (`PILL_SHEEN_OPACITY`), a thin translucent white edge stroke (`PILL_BORDER_OPACITY`) so the panel still reads as a distinct glass element at that transparency, and a soft drop-shadow behind the text so it stays legible even over a light, busy background. Pill height/corner rounding was pixel-measured directly off toptoday.llamayu.com's own output rather than eyeballed; width is dynamic (see Pill sizing above). All of the above are separate constants at the top of `lib/badge.js` if you want to tune the look further.
- This was verified end-to-end in a sandboxed test: real `sharp`/`resvg-js` rendering of both overlays against synthetic posters in light, dark, and mid-tone colors (correct dynamic-width geometry per label, one consistent font size and letter-spacing, visibly separated letterforms, noticeably lighter/more transparent tint than the previous pass), and unit tests of the date/status logic (recency windows and gates, the Premiere-vs-Finale single-episode edge case, the Netflix whole-season-binge-drop Premiere case, series/season finale detection) against a range of scenarios. The live TMDB, `btttr.cc`, and Vercel deploy could not be exercised from that sandbox (network is restricted there), so double check the first deploy's catalogs load correctly in Stremio — if `TMDB_API_KEY` is wrong you'll see a 500 from `/catalog/...json`.
