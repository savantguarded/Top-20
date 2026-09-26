# Top Charts Today (Stremio / Nuvio addon)

Two catalogs, ranked daily from TMDB trending:

- **Top Movies Today**: out digitally or on disc in the US (or digital release within 3 days).
- **Top Shows Today**: already airing, or premiering within 7 days.

Every card gets a glossy rank number and a status pill ("Just Added", "Airing Today", "Streaming Oct 3", "Season Finale Oct 2", ...). Landscape cards also show the top US subscription service carrying the title (bottom right), when there is one. Each catalog item carries:

| Field | What it is |
| --- | --- |
| `poster` | Portrait card, art per **Portrait art** setting |
| `landscapePoster` | Landscape card (Nuvio reads this and draws nothing over it), art per **Landscape art** |
| `background` | Clean TMDB backdrop, no overlays |
| `logo` | TMDB clearlogo |

No database or cron: catalogs are edge-cached for an hour and rebuild themselves.

Streaming availability data is provided by [JustWatch](https://www.justwatch.com), via TMDB.

Dates follow the Africa/Lagos calendar (`TIMEZONE` in `lib/tmdb.js`). Episodes airing within a day of today are re-dated from their exact [TVmaze](https://www.tvmaze.com) airstamp, so a Sunday 9pm ET episode reads "Airing Today" on Monday in Lagos.

## Deploy

1. Import this repo into Vercel.
2. Environment variables:
   - `TMDB_API_KEY` (required)
   - `MDBLIST_API_KEY` (optional, fills `{mdblist_key}` in provider URLs)
3. Deploy. Install `https://<project>.vercel.app/manifest.json` in Nuvio, or `/stremio/manifest.json` in Stremio (rank badge top-right, clear of Stremio's watched checkmark).

## Settings page: `/backstage-<key>`

| Setting | Options |
| --- | --- |
| Portrait art | Default TMDB, Alternate TMDB (textless + clearlogo), BetterPosters, Custom URL |
| Landscape art | Default TMDB (logo in image), Alternate TMDB (textless + clearlogo), Custom URL |

Custom URL placeholders: `{imdbId}` / `{id}`, `{tmdb_id}`, `{type}` (movie/tv), `{tmdb_key}`, `{mdblist_key}`, `{backdrop_path}`. Keys are filled server-side only.

Saving clears the cached catalogs. Clients still hold their own copy: force-stop Nuvio to see changes immediately.

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
lib/art.js       picks the landscape alternate least like the main backdrop
lib/config.js    defaults + Edge Config
```

This product uses the TMDB API but is not endorsed or certified by TMDB.
