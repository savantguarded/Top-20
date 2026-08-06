# Top Charts Today (Stremio addon)

Two catalogs, ranked daily:

- **Top Movies Today** — top 20 US movies currently out digitally or on home release (TMDB `discover/movie`, `with_release_type=4|5`, region `US`), ranked by popularity. Theatrical-only movies are excluded.
- **Top Shows Today** — top 20 shows from TMDB's daily trending list.

Each poster is the base image from `btttr.cc` with a glossy rank number composited on top (falls back to TMDB's own poster if `btttr.cc` doesn't have that title). Every title's imdb_id is round-tripped through TMDB's `/find` endpoint before it's included, so a stale or mismatched cross-reference gets dropped instead of showing the wrong movie/show once you click into it in Stremio.

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
- `GET /poster/:type/:imdb/:rank.jpg` renders the numbered poster on demand (also edge-cached).

## Project layout

```
api/
  manifest.js   -> /manifest.json
  catalog.js    -> /catalog/:type/:id.json
  poster.js     -> /poster/:type/:imdb/:rank.jpg
lib/
  tmdb.js       -> TMDB discover/trending + imdb_id resolution + /find round-trip verification
  badge.js      -> renders the glossy rank number and composites it onto the poster
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

- **Region**: hardcoded to `US` in `lib/tmdb.js` (both the release-type filter for movies and the general context). Change the `region` value there if you ever want a different market.
- **"Digital or home release"**: TMDB release type `4` = Digital, `5` = Physical (per TMDB's own docs: 1 Premiere, 2 Theatrical limited, 3 Theatrical, 4 Digital, 5 Physical, 6 TV). If you also want to include limited theatrical re-releases or premiere dates, adjust `with_release_type` in `lib/tmdb.js`.
- **ID accuracy**: for every candidate, `lib/tmdb.js` calls `/find/{imdb_id}` and confirms it resolves back to the same TMDB id with a matching (or near-matching, accents/subtitle-tolerant) title before including it. Anything that fails this check is silently dropped rather than risking a wrong title showing up when you open it in Stremio.
- **Always a full 20**: since that verification step (and the occasional title with no imdb_id at all) can drop a few candidates, both list functions pull a pool of 30 raw candidates from TMDB before filtering down to the 20 that pass, so the catalog stays full even after a few get rejected. If TMDB ever has fewer than 20 valid, verified candidates for a given day, you'll get however many pass instead of a hard failure. Adjust `POOL_SIZE` in `lib/tmdb.js` if you want a bigger safety margin.
- **TMDB attribution**: the manifest description includes TMDB's required "This product uses the TMDB API but is not endorsed or certified by TMDB" notice, per their API Terms of Use.
- **btttr.cc outages**: if a poster fails to load from `btttr.cc`, `api/poster.js` automatically falls back to TMDB's own poster image so a catalog entry never shows a broken image.
- **Rank badge look**: built as an SVG (glossy white→gray gradient fill, dark bevel stroke, dual drop-shadow) rendered via `@resvg/resvg-js` with the bundled Inter Black font, then composited with `sharp`. Single- and double-digit ranks use the same font size and anchor point so "4" and "20" carry equal visual weight. Tested against both light and dark poster backgrounds. Tweak the gradient stops / shadow values / `fontSize` in `lib/badge.js` if you want it lighter, darker, or a different size.
- This was verified end-to-end for image rendering (font, gradient, shadow, compositing) and for the title-matching logic (unit-tested against accented titles, exact matches, and unrelated titles) in a sandboxed test. The live TMDB and `btttr.cc` calls could not be tested from that sandbox (network is restricted there), so double check the first deploy's catalogs load correctly in Stremio — if `TMDB_API_KEY` is wrong you'll see a 500 from `/catalog/...json`.
