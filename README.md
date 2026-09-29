# Daily Charts (Nuvio addon)

Two catalogs ranked daily from TMDB trending, plus an unranked Coming Soon row:

- **Top Movies Today**: out digitally or on disc in the US (or digital release within 3 days).
- **Top Shows Today**: already airing, or premiering within 7 days. Japanese, Chinese and Korean animation (anime, donghua) excluded.
- **Coming Soon**: movies and shows mixed, 20 items over the next 30 days, soonest first. Movies: first US digital release. Shows: premieres, new seasons and returns after a 14+ day break (not weekly episodes). Candidates come from TMDB discover, most popular first, above a popularity floor; at least 6 of each type when that many exist. Declared as a `movie` catalog, but each item carries its own type (Nuvio reads it per item). Tunables: `comingSoon` in `DEFAULTS`.

Ranked cards get a glossy rank number; every card gets a status pill (see **Status labels** below). Landscape cards also show the top US subscription service carrying the title (bottom right), when there is one. Each catalog item carries:

| Field | What it is |
| --- | --- |
| `poster` | Portrait card, art per **Portrait art** setting |
| `landscapePoster` | Landscape card (Nuvio reads this and draws nothing over it), art per **Landscape art** |
| `background` | Clean TMDB backdrop, no overlays |
| `logo` | TMDB clearlogo |

No database or cron: catalogs are edge-cached for an hour and rebuild themselves.

Streaming availability data is provided by [JustWatch](https://www.justwatch.com), via TMDB.

Dates follow the Africa/Lagos calendar (`TIMEZONE` in `lib/tmdb.js`). Episodes airing within a day of today are re-dated from their exact [TVmaze](https://www.tvmaze.com) airstamp, so a Sunday 9pm ET episode reads "Airing Today" on Monday in Lagos.

## Status labels

First match wins. Windows live in `DEFAULTS` in `lib/config.js`.

**Movies**

| Label | When |
| --- | --- |
| Now on Blu-ray | Physical release in the last 7 days |
| Just Added | Digital release, days 0 to 3 |
| Now Streaming | Digital release, days 4 to 7 |
| Streaming *date* | Digital release within the next 3 days |

**Shows**

| Label | When |
| --- | --- |
| Premieres *date* | New series, up to 7 days out |
| New Season *date* | Season 2+, up to 7 days out |
| Full Season | Binge drop (finale out on premiere day), for 7 days |
| Series / Season Premiere | Premiere day only |
| Airing Today | An episode airs today (finales show as Season / Series Finale) |
| New Series / New Season | Days 1 to 7 after a weekly premiere |
| Season Finale *date* | Finale airs within 7 days |
| Season / Series Finale | Finale aired in the last 7 days |
| New Episode | Episode aired 1 to 2 days ago |
| Next Ep *date* | Next episode within 7 days |
| Returns *date* | Same, after a gap of over 14 days |

**Coming Soon**

| Label | When |
| --- | --- |
| Out Today | Movie's digital release day |
| Streaming *date* | Movie's digital release, up to 30 days out |
| Premieres / New Season / Returns *date* | Show, up to 30 days out |
| Series / Season Premiere, Full Season, Returns Today | Show, on the day |

*date* reads "Tomorrow", then the weekday up to 5 days out ("Fri"), then "Oct 4".

After changing label logic, run `npm test` (`scripts/labels.test.js`, no network needed).

## Deploy

1. Import this repo into Vercel.
2. Environment variables:
   - `TMDB_API_KEY` (required)
   - `MDBLIST_API_KEY` (optional, fills `{mdblist_key}` in provider URLs)
3. Deploy. Install `https://<project>.vercel.app/manifest.json` in Nuvio.
   For wide cards with Nuvio's Landscape posters toggle left off, install `/landscape/manifest.json` instead. Same name, its own id, so it sits alongside a portrait install and changes nothing for other installs. The settings page builds either link (Portrait / Landscape toggle, not saved).

## Settings page: `/backstage-<key>`

| Setting | Options |
| --- | --- |
| Portrait art | Default TMDB, Alternate TMDB (textless + clearlogo), BetterPosters, Custom URL |
| Landscape art | Default TMDB (logo in image), Alternate TMDB (textless + clearlogo), Custom URL |
| Catalogs | Rename any row and set their order (clients read this at install: reinstall if a change doesn't show) |

Alternate TMDB art rotates: each title steps through up to 4 visually distinct textless images, one per day, with change-over times staggered per title so a row changes a card or two at a time. Near-duplicate uploads are screened out, so a title with only one good image stays put. Tune with `artRotationHours` (0 = off) and `artRotationPool` in the Edge Config item. Each change-over re-renders that card once, roughly 0.3 to 0.5s of CPU.

Custom URL placeholders: `{imdbId}` / `{id}`, `{tmdb_id}`, `{type}` (movie/tv), `{tmdb_key}`, `{mdblist_key}`, `{backdrop_path}`. Keys are filled server-side only.

Saving clears the cached catalogs and manifests. Clients still hold their own copy: force-stop Nuvio to see changes immediately.

One-time setup:

1. Vercel → Storage → create an **Edge Config** store and connect it (adds `EDGE_CONFIG`).
2. Create a Vercel API token (Account Settings → Tokens) and add it as `VERCEL_API_TOKEN`. Team projects also need `VERCEL_TEAM_ID`.
3. Add `BACKSTAGE_KEY` (any string: the page lives at `/backstage-<that string>`).
4. Redeploy.

Set `BACKSTAGE_KEY` in Vercel to choose `<key>`; without it the page is disabled. Other tunables (region, catalog size, label windows; see `DEFAULTS` in `lib/config.js`) can be set in the Edge Config item `topTwentyConfig` directly.

## Layout

```
api/catalog.js   catalog JSON, picks art per setting
api/poster.js    renders a card (provider or TMDB image + overlays)
api/config.js    settings page
api/meta.js      fallback meta (lib/meta.js); list this addon after your main meta addon
lib/tmdb.js      trending, eligibility, status labels, art paths
lib/badge.js     rank badge, pill, vignette, clearlogo compositing
lib/art.js       alternate-art pools (near-duplicates screened out) and daily rotation
lib/config.js    defaults + Edge Config
```

This product uses the TMDB API but is not endorsed or certified by TMDB.
