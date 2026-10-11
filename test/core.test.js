const test = require('node:test');
const assert = require('node:assert');
const fixture = require('./fixtures/scoreboard.json');
const core = require('../public/core');

const HOUR = 3600 * 1000;
const at = (ms) => new Date(ms).toISOString();
const game = (id, date, state = 'pre', h = null, a = null, completed = state === 'post') => ({
  id, date, state, completed, detail: '', home: { name: 'H', score: h }, away: { name: 'A', score: a },
});

test('normalizes ESPN events', () => {
  const [live, upcoming, final] = core.normalizeScoreboard(fixture).events;
  assert.strictEqual(live.state, 'in');
  assert.strictEqual(live.home.name, 'Liverpool');
  assert.strictEqual(live.home.score, 2);
  assert.strictEqual(upcoming.state, 'pre');
  assert.strictEqual(upcoming.broadcast, 'NBC, Peacock');
  assert.strictEqual(final.completed, true);
  assert.deepStrictEqual(core.normalizeScoreboard(null).events, []);
});

test('predictions lock 2 hours before kick-off', () => {
  const now = Date.now();
  assert.strictEqual(core.isOpen(game('a', at(now + 2 * HOUR + 60000)), now), true);
  assert.strictEqual(core.isOpen(game('b', at(now + 2 * HOUR - 60000)), now), false);
  assert.strictEqual(core.isOpen(game('c', at(now - HOUR), 'in'), now), false);
  assert.strictEqual(core.deadlineOf(game('d', '2026-10-17T14:00:00Z')).toISOString(), '2026-10-17T12:00:00.000Z');
});

test('scores 3 for exact, 1 for right result, 0 otherwise', () => {
  const ft = game('x', at(0), 'post', 2, 1);
  assert.deepStrictEqual(core.scorePrediction({ home: 2, away: 1 }, ft), { points: 3, kind: 'exact' });
  assert.deepStrictEqual(core.scorePrediction({ home: 3, away: 0 }, ft), { points: 1, kind: 'result' });
  assert.deepStrictEqual(core.scorePrediction({ home: 1, away: 1 }, ft), { points: 0, kind: 'miss' });
  const draw = game('y', at(0), 'post', 1, 1);
  assert.strictEqual(core.scorePrediction({ home: 0, away: 0 }, draw).points, 1);
  assert.strictEqual(core.scorePrediction({ home: 2, away: 1 }, game('z', at(0), 'in', 2, 1)), null);
  assert.strictEqual(core.scorePrediction({ home: 0, away: 0 }, game('p', at(0), 'post', 0, 0, false)), null, 'called off');
  assert.strictEqual(core.scorePrediction(undefined, ft), null);
});

test('groups fixtures into matchweeks by 36h gaps', () => {
  const t = Date.parse('2026-10-16T19:00:00Z'); // Friday
  const evs = [
    game('fri', at(t)), game('sat', at(t + 17.5 * HOUR)), game('sun', at(t + 43.5 * HOUR)), game('mon', at(t + 72 * HOUR)),
    game('tue', at(t + 11 * 24 * HOUR)), // midweek round the following Tue + Wed
    game('wed', at(t + 12 * 24 * HOUR)),
    game('sat2', at(t + 14.75 * 24 * HOUR)),
  ];
  const weeks = core.groupMatchweeks(evs.reverse());
  assert.deepStrictEqual(weeks.map((w) => w.events.map((e) => e.id)), [['fri', 'sat', 'sun', 'mon'], ['tue', 'wed'], ['sat2']]);
});

test('opens on the first week with unfinished games', () => {
  const weeks = [
    { events: [game('a', at(0), 'post', 1, 0)] },
    { events: [game('b', at(1), 'post', 1, 0), game('c', at(2), 'in', 0, 0)] },
    { events: [game('d', at(3))] },
  ];
  assert.strictEqual(core.currentWeekIndex(weeks), 1);
  assert.strictEqual(core.currentWeekIndex([weeks[0]]), 0);
});

test('leaderboard ranks by points then exact scores, ties share a rank', () => {
  const events = [game('g1', at(0), 'post', 2, 1), game('g2', at(1), 'post', 0, 0), game('g3', at(2))];
  const rows = core.leaderboard({
    u1: { name: 'Abebe', predictions: { g1: { home: 2, away: 1 }, g2: { home: 1, away: 0 }, g3: { home: 1, away: 1 } } },
    u2: { name: 'Sara', predictions: { g1: { home: 1, away: 0 }, g2: { home: 1, away: 1 } } },
    u3: { name: 'Dawit', predictions: { g1: { home: 2, away: 1 } } },
    u4: { name: 'Hana', predictions: {} },
  }, events);
  assert.deepStrictEqual(rows.map((r) => [r.rank, r.name, r.points, r.exact, r.results, r.scored]), [
    [1, 'Abebe', 3, 1, 0, 2],
    [1, 'Dawit', 3, 1, 0, 1],
    [3, 'Sara', 2, 0, 2, 2],
    [4, 'Hana', 0, 0, 0, 0],
  ]);
});

test('validates goals and date ranges', () => {
  assert.ok(core.validGoals(0) && core.validGoals(20));
  assert.ok(!core.validGoals(-1) && !core.validGoals(21) && !core.validGoals(1.5));
  assert.ok(core.isDates('20261011') && core.isDates('20261001-20261031'));
  assert.ok(!core.isDates('2026-10-11') && !core.isDates(''));
  assert.strictEqual(core.dateRange(new Date(2026, 9, 11), 14, 35), '20260927-20261115');
});
