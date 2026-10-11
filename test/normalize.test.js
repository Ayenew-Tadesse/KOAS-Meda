const test = require('node:test');
const assert = require('node:assert');
const fixture = require('./fixtures/scoreboard.json');
const { normalizeScoreboard } = require('../src/normalize');

test('normalizes ESPN scoreboard into compact events', () => {
  const sb = normalizeScoreboard(fixture, 'epl');
  assert.strictEqual(sb.leagueName, 'English Premier League');
  assert.strictEqual(sb.events.length, 3);

  const [live, upcoming, final] = sb.events;
  assert.strictEqual(live.state, 'in');
  assert.strictEqual(live.detail, "63'");
  assert.strictEqual(live.home.name, 'Liverpool');
  assert.strictEqual(live.home.score, '2');
  assert.strictEqual(live.away.short, 'ARS');
  assert.strictEqual(live.home.color, '#d11317');
  assert.strictEqual(live.broadcast, 'Sky Sports');

  assert.strictEqual(upcoming.state, 'pre');
  assert.strictEqual(upcoming.broadcast, 'NBC, Peacock');

  assert.strictEqual(final.state, 'post');
  assert.strictEqual(final.home.winner, true);
  assert.strictEqual(final.away.winner, false);
});

test('tolerates empty payloads', () => {
  assert.deepStrictEqual(normalizeScoreboard({}, 'nba').events, []);
  assert.deepStrictEqual(normalizeScoreboard(null, 'nba').events, []);
});
