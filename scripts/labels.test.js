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
mod._compile(`${fs.readFileSync(file, 'utf8')}\nmodule.exports.__t = { computeShowContext, computeMovieContext, formatShortDate };`, file);
const { computeShowContext, computeMovieContext, formatShortDate } = mod.exports.__t;
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

if (failed) {
  console.log(`${failed} label check(s) failed`);
  process.exit(1);
}
console.log('All label checks passed');
