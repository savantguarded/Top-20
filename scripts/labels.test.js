// scripts/labels.test.js
// Status-label checks for lib/tmdb.js. No dependencies, no network: `npm test`.
// Dates are built relative to today on the Lagos calendar, so it passes on any day.
// lib/tmdb.js has no exports, so it's compiled here with its helpers exposed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const file = path.join(__dirname, '..', 'lib', 'tmdb.js');
const mod = new Module(file);
mod.filename = file;
mod.paths = Module._nodeModulePaths(path.dirname(file));
mod._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.__t = { computeShowContext, computeMovieContext, formatShortDate, comingDigitalDate, comingMovieLabel, classifyComingShow, comingShowLabel, mixComingSoon, isWantedComingShow, alreadyOnSale };`, file);
const { computeShowContext, computeMovieContext, formatShortDate, comingDigitalDate, comingMovieLabel, classifyComingShow, comingShowLabel, mixComingSoon, isWantedComingShow, alreadyOnSale } = mod.exports.__t;
const { DEFAULTS } = require('../lib/config');

// d days ago (negative = in the future), YYYY-MM-DD on the Lagos calendar.
const ago = (d) => new Date(Date.now() - d * 864e5).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const weekday = (d) => new Date(`${ago(d)}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const monthDay = (d) => new Date(`${ago(d)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const show = DEFAULTS.show;
const movie = DEFAULTS.movie;
const ep = (season, episode, d) => ({ season_number: season, episode_number: episode, air_date: ago(d) });
const s2 = (d, count = 10) => [{ season_number: 1, air_date: '2024-01-01', episode_count: 8 }, { season_number: 2, air_date: ago(d), episode_count: count }];
const running = (extra) => ({ first_air_date: '2024-01-01', status: 'Returning Series', seasons: s2(60), ...extra });

let failed = 0;
function check(name, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
  } catch {
    failed += 1;
    console.log(`FAIL  ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// Dates
check('date tomorrow', formatShortDate(ago(-1)), 'Tomorrow');
check('date 5 days out', formatShortDate(ago(-5)), weekday(-5));
check('date 6 days out', formatShortDate(ago(-6)), monthDay(-6));

// Weekly show through one week
check('ep today', computeShowContext(running({ last_episode_to_air: ep(2, 5, 0), next_episode_to_air: ep(2, 6, -7) }), show), 'Airing Today');
check('ep 1 day ago', computeShowContext(running({ last_episode_to_air: ep(2, 5, 1), next_episode_to_air: ep(2, 6, -6) }), show), 'New Episode');
check('ep 2 days ago', computeShowContext(running({ last_episode_to_air: ep(2, 5, 2), next_episode_to_air: ep(2, 6, -5) }), show), 'New Episode');
check('ep 3 days ago', computeShowContext(running({ last_episode_to_air: ep(2, 5, 3), next_episode_to_air: ep(2, 6, -4) }), show), `Next Ep ${weekday(-4)}`);
check('ep 6 days ago', computeShowContext(running({ last_episode_to_air: ep(2, 5, 6), next_episode_to_air: ep(2, 6, -1) }), show), 'Next Ep Tomorrow');
check('ep 3 days ago, nothing next', computeShowContext(running({ last_episode_to_air: ep(2, 5, 3) }), show), null);

// Breaks and finales
check('back from break', computeShowContext(running({ last_episode_to_air: ep(2, 5, 40), next_episode_to_air: ep(2, 6, -6) }), show), `Returns ${monthDay(-6)}`);
check('upcoming finale', computeShowContext(running({ last_episode_to_air: ep(2, 9, 4), next_episode_to_air: ep(2, 10, -3) }), show), `Season Finale ${weekday(-3)}`);
check('finale aired', computeShowContext(running({ last_episode_to_air: ep(2, 10, 5) }), show), 'Season Finale');
check('series finale aired', computeShowContext(running({ status: 'Ended', last_episode_to_air: ep(2, 10, 5) }), show), 'Series Finale');

// Premieres
check('series premieres soon', computeShowContext({ first_air_date: ago(-6), seasons: [] }, show), `Premieres ${monthDay(-6)}`);
check('season 2 soon', computeShowContext({ first_air_date: '2024-01-01', seasons: s2(-3) }, show), `New Season ${weekday(-3)}`);
check('weekly premiere day', computeShowContext({ first_air_date: '2024-01-01', seasons: s2(0), last_episode_to_air: ep(2, 1, 0), next_episode_to_air: ep(2, 2, -7) }, show), 'Season Premiere');
check('weekly premiere +3', computeShowContext({ first_air_date: '2024-01-01', seasons: s2(3), last_episode_to_air: ep(2, 1, 3), next_episode_to_air: ep(2, 2, -4) }, show), 'New Season');
check('full drop day 0', computeShowContext({ first_air_date: '2024-01-01', seasons: s2(0, 8), last_episode_to_air: ep(2, 8, 0) }, show), 'Full Season');
check('full drop +5', computeShowContext({ first_air_date: '2024-01-01', seasons: s2(5, 8), last_episode_to_air: ep(2, 8, 5) }, show), 'Full Season');

// Movies
check('just added', computeMovieContext(ago(2), null, null, movie), 'Just Added');
check('now streaming', computeMovieContext(ago(6), null, null, movie), 'Now Streaming');
check('streaming aged out', computeMovieContext(ago(9), null, null, movie), null);
check('blu-ray', computeMovieContext(ago(30), ago(3), null, movie), 'Now on Blu-ray');
check('streaming soon', computeMovieContext(null, null, ago(-2), movie), `Streaming ${weekday(-2)}`);

// Coming Soon
const rd = (...dates) => ({ results: [{ iso_3166_1: 'US', release_dates: dates.map((d) => ({ type: 4, release_date: `${ago(d)}T00:00:00.000Z` })) }] });
check('coming: digital in window', comingDigitalDate(rd(-10), 'US', 30), ago(-10));
check('coming: digital today excluded', comingDigitalDate(rd(0), 'US', 30), null);
check('coming: past the window', comingDigitalDate(rd(-31), 'US', 30), null);
check('coming: already out digitally', comingDigitalDate(rd(20, -5), 'US', 30), null);
check('coming: streaming tomorrow', comingMovieLabel(ago(-1)), 'Streaming Tomorrow');
check('coming: streaming later', comingMovieLabel(ago(-12)), `Streaming ${monthDay(-12)}`);

const cs = (details) => { const c = classifyComingShow(details, 30); return c && comingShowLabel(c); };
check('coming: premiere', cs({ first_air_date: ago(-9), seasons: [{ season_number: 1, air_date: ago(-9), episode_count: 8 }] }), `Premieres ${monthDay(-9)}`);
check('coming: premiere past window', cs({ first_air_date: ago(-40) }), null);
check('coming: new season', cs(running({ seasons: s2(-3), last_episode_to_air: ep(1, 8, 200), next_episode_to_air: ep(2, 1, -3) })), `New Season ${weekday(-3)}`);
check('coming: returns', cs(running({ last_episode_to_air: ep(2, 4, 40), next_episode_to_air: ep(2, 5, -6) })), `Returns ${monthDay(-6)}`);
check('coming: return today excluded', cs(running({ last_episode_to_air: ep(2, 4, 40), next_episode_to_air: ep(2, 5, 0) })), null);
check('coming: weekly episode excluded', cs(running({ last_episode_to_air: ep(2, 4, 7), next_episode_to_air: ep(2, 5, -1) })), null);
check('coming: season premiere today excluded', cs(running({ seasons: s2(0), last_episode_to_air: ep(2, 1, 0), next_episode_to_air: ep(2, 2, -7) })), null);
check('coming: series premiere today excluded', cs({ first_air_date: ago(0), last_episode_to_air: ep(1, 1, 0), next_episode_to_air: ep(1, 2, -7) }), null);

check('wanted: english drama', isWantedComingShow({ original_language: 'en', genre_ids: [18] }), true);
check('wanted: talk show', isWantedComingShow({ original_language: 'en', genre_ids: [10767] }), false);
check('wanted: reality', isWantedComingShow({ original_language: 'en', genres: [{ id: 10764 }] }), false);
check('wanted: kids', isWantedComingShow({ original_language: 'en', genre_ids: [10762, 16] }), false);
check('wanted: animated family', isWantedComingShow({ original_language: 'en', genre_ids: [16, 10751, 35] }), false);
check('wanted: kids channel', isWantedComingShow({ original_language: 'en', genres: [{ id: 16 }], networks: [{ name: 'Disney XD' }] }), false);
check('wanted: adult animation', isWantedComingShow({ original_language: 'en', genre_ids: [16, 35], networks: [{ name: 'Adult Swim' }] }), true);
check('wanted: korean variety', isWantedComingShow({ original_language: 'ko', genre_ids: [35] }), false);

const wp = (kinds) => ({ results: { US: Object.fromEntries(kinds.map((k) => [k, [{ provider_name: 'Apple TV' }]])) } });
check('on sale: future date, already rentable', alreadyOnSale(ago(-3), wp(['rent', 'buy']), 'US'), true);
check('on sale: future date, nothing listed', alreadyOnSale(ago(-3), wp([]), 'US'), false);
check('on sale: future date, streaming only', alreadyOnSale(ago(-3), wp(['flatrate']), 'US'), false);
check('on sale: release day', alreadyOnSale(ago(0), wp(['rent']), 'US'), false);

const it = (type, pop, d) => ({ type, popularity: pop, date: ago(-d), imdbId: `${type}${pop}` });
const mv = Array.from({ length: 20 }, (_, i) => it('movie', 1000 - i, i));
const tv = Array.from({ length: 20 }, (_, i) => it('series', 50 - i, 20 - i));
const mixed = mixComingSoon(mv, tv, 20, 6);
check('mix: size', mixed.length, 20);
check('mix: min shows kept', mixed.filter((x) => x.type === 'series').length, 6);
check('mix: soonest first', mixed.every((x, i) => i === 0 || mixed[i - 1].date <= x.date), true);
check('mix: short on shows', mixComingSoon(mv, tv.slice(0, 2), 20, 6).filter((x) => x.type === 'series').length, 2);
check('mix: few overall', mixComingSoon(mv.slice(0, 3), tv.slice(0, 4), 20, 6).length, 7);

if (failed) {
  console.log(`${failed} label check(s) failed`);
  process.exit(1);
}
console.log('All label checks passed');
