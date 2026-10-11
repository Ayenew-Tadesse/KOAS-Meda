const fs = require('fs');
const path = require('path');
const { byKey } = require('../public/leagues');
const { normalizeScoreboard } = require('../public/normalize');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15000);
const MOCK = process.env.MOCK === '1';

const cache = new Map(); // key -> { at, data, pending }

function scoreboardUrl(league, date) {
  const url = new URL(`${BASE}/${league.sport}/${league.league}/scoreboard`);
  if (date) url.searchParams.set('dates', date); // YYYYMMDD
  return url.toString();
}

async function fetchRaw(league, date) {
  if (MOCK) {
    const file = path.join(__dirname, '..', 'test', 'fixtures', 'scoreboard.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const res = await fetch(scoreboardUrl(league, date), {
    headers: { 'User-Agent': 'koas-meda/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ESPN responded ${res.status} for ${league.key}`);
  return res.json();
}

// Fetches a league's scoreboard with a short cache so many browsers polling
// the server only cost one upstream request per TTL window.
async function getScoreboard(leagueKey, date) {
  const league = byKey[leagueKey];
  if (!league) {
    const err = new Error(`Unknown league "${leagueKey}"`);
    err.status = 404;
    throw err;
  }
  if (date && !/^\d{8}$/.test(date)) {
    const err = new Error('date must be YYYYMMDD');
    err.status = 400;
    throw err;
  }

  const key = `${leagueKey}:${date || 'today'}`;
  const hit = cache.get(key);
  if (hit && hit.data && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  if (hit && hit.pending) return hit.pending;

  const pending = fetchRaw(league, date)
    .then((raw) => {
      const data = { ...normalizeScoreboard(raw, leagueKey), leagueName: league.name, updatedAt: new Date().toISOString() };
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .catch((err) => {
      // Serve stale data rather than nothing if the upstream hiccups.
      if (hit && hit.data) {
        cache.set(key, hit);
        return { ...hit.data, stale: true };
      }
      cache.delete(key);
      throw err;
    });
  cache.set(key, { ...(hit || {}), pending });
  return pending;
}

module.exports = { getScoreboard, scoreboardUrl };
