const fs = require('fs');
const path = require('path');
const core = require('../public/core');

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15000);
const MOCK = process.env.MOCK === '1';

const cache = new Map(); // dates -> { at, data, pending }

async function fetchRaw(dates) {
  if (MOCK) {
    const file = path.join(__dirname, '..', 'test', 'fixtures', 'scoreboard.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const url = `${core.ESPN_SCOREBOARD}?limit=200&dates=${dates}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'koas-meda/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
  return res.json();
}

// Premier League fixtures for a date or date range, cached briefly so many
// browsers polling the server cost one upstream request per TTL window.
async function getScoreboard(dates) {
  if (!dates || !core.isDates(dates)) {
    const err = new Error('dates must be YYYYMMDD or YYYYMMDD-YYYYMMDD');
    err.status = 400;
    throw err;
  }
  const hit = cache.get(dates);
  if (hit && hit.data && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  if (hit && hit.pending) return hit.pending;

  const pending = fetchRaw(dates)
    .then((raw) => {
      const data = { ...core.normalizeScoreboard(raw), updatedAt: new Date().toISOString() };
      cache.set(dates, { at: Date.now(), data });
      return data;
    })
    .catch((err) => {
      // Serve stale data rather than nothing if the upstream hiccups.
      if (hit && hit.data) {
        cache.set(dates, { at: hit.at, data: hit.data });
        return { ...hit.data, stale: true };
      }
      cache.delete(dates);
      throw err;
    });
  cache.set(dates, { ...(hit || {}), pending });
  return pending;
}

module.exports = { getScoreboard };
