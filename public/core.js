// Premier League score-prediction rules and ESPN parsing, shared by the
// Node server (require) and the browser (window.KOAS.core). Pure functions only.
(() => {
  const LEAGUE = { name: 'Premier League', sport: 'soccer', league: 'eng.1' };
  const ESPN_SCOREBOARD = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE.sport}/${LEAGUE.league}/scoreboard`;

  // Rules. Keep in sync with supabase/schema.sql.
  const DEADLINE_MS = 2 * 60 * 60 * 1000; // predictions lock 2 hours before kick-off
  const POINTS = { exact: 3, result: 1 }; // exact score / right result (win, draw or loss)
  const MAX_GOALS = 20;
  const WINDOW_DAYS = 7; // fixtures shown: 7 days back to 7 days ahead (two weeks)
  const WEEK_GAP_MS = 36 * 60 * 60 * 1000; // a 36h+ gap between kick-offs starts a new matchweek

  // ---- Dates -------------------------------------------------------------

  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

  // ESPN's scoreboard takes one day per request (YYYYMMDD); date ranges return 400.
  function days(from, daysBack, daysAhead) {
    const out = [];
    for (let i = -daysBack; i <= daysAhead; i += 1) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      out.push(ymd(d));
    }
    return out;
  }

  const isDates = (s) => /^\d{8}$/.test(s);

  // ---- ESPN scoreboard ---------------------------------------------------

  function normalizeTeam(c = {}) {
    const team = c.team || {};
    return {
      id: team.id || c.id || null,
      name: team.displayName || team.name || 'TBD',
      short: team.abbreviation || team.shortDisplayName || '',
      logo: team.logo || (team.logos && team.logos[0] && team.logos[0].href) || null,
      color: team.color ? `#${team.color}` : null,
      score: c.score != null && c.score !== '' ? Number(c.score) : null,
    };
  }

  function normalizeEvent(ev) {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const status = ev.status || comp.status || {};
    const type = status.type || {};
    const competitors = comp.competitors || [];
    const home = competitors.find((c) => c.homeAway === 'home') || competitors[0];
    const away = competitors.find((c) => c.homeAway === 'away') || competitors[1];
    return {
      id: String(ev.id),
      date: ev.date || comp.date || null,
      // ESPN state: "pre" (scheduled), "in" (live), "post" (over, or called off when not completed).
      state: type.state || 'pre',
      completed: Boolean(type.completed),
      detail: type.shortDetail || type.detail || type.description || '',
      venue: (comp.venue && comp.venue.fullName) || null,
      broadcast: (comp.broadcasts || []).flatMap((b) => b.names || []).join(', ') || null,
      home: normalizeTeam(home),
      away: normalizeTeam(away),
    };
  }

  function normalizeScoreboard(payload) {
    const events = (payload && payload.events) || [];
    return { events: events.map(normalizeEvent) };
  }

  // ---- Matchweeks --------------------------------------------------------

  // ESPN's soccer feed has no matchweek number, so fixtures are grouped by
  // kick-off time. Within a round games are at most ~28h apart (Fri night to
  // Mon night); between rounds the gap is 50h+, so 36h separates them.
  function groupMatchweeks(events) {
    const sorted = [...events].filter((e) => e.date).sort((a, b) => new Date(a.date) - new Date(b.date));
    const weeks = [];
    let current = null;
    let last = 0;
    for (const e of sorted) {
      const t = new Date(e.date).getTime();
      if (!current || t - last >= WEEK_GAP_MS) {
        current = { id: e.id, start: e.date, events: [] };
        weeks.push(current);
      }
      current.events.push(e);
      last = t;
    }
    weeks.forEach((w) => { w.end = w.events[w.events.length - 1].date; });
    return weeks;
  }

  // The week to open on: the first one with a game not yet finished, else the latest.
  function currentWeekIndex(weeks) {
    const i = weeks.findIndex((w) => w.events.some((e) => e.state !== 'post'));
    return i === -1 ? weeks.length - 1 : i;
  }

  // ---- Predictions -------------------------------------------------------

  const deadlineOf = (event) => new Date(new Date(event.date).getTime() - DEADLINE_MS);
  const isOpen = (event, now = Date.now()) => event.state === 'pre' && now < deadlineOf(event).getTime();

  function validGoals(n) {
    return Number.isInteger(n) && n >= 0 && n <= MAX_GOALS;
  }

  const outcome = (h, a) => (h > a ? 'home' : h < a ? 'away' : 'draw');

  // Points for one prediction once the match has finished; null until then
  // (or if it was called off).
  function scorePrediction(pred, event) {
    if (!pred || !event || event.state !== 'post' || !event.completed) return null;
    const h = event.home.score;
    const a = event.away.score;
    if (h == null || a == null) return null;
    if (pred.home === h && pred.away === a) return { points: POINTS.exact, kind: 'exact' };
    if (outcome(pred.home, pred.away) === outcome(h, a)) return { points: POINTS.result, kind: 'result' };
    return { points: 0, kind: 'miss' };
  }

  // Totals per player from their predictions and finished matches.
  // predictionsByUser: { [userId]: { name, predictions: { [eventId]: {home, away} } } }
  function leaderboard(predictionsByUser, events) {
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));
    const rows = Object.entries(predictionsByUser).map(([id, u]) => {
      const row = { id, name: u.name, points: 0, exact: 0, results: 0, scored: 0 };
      for (const [eventId, pred] of Object.entries(u.predictions || {})) {
        const s = scorePrediction(pred, byId[eventId]);
        if (!s) continue;
        row.scored += 1;
        row.points += s.points;
        if (s.kind === 'exact') row.exact += 1;
        if (s.kind === 'result') row.results += 1;
      }
      return row;
    });
    return rankRows(rows);
  }

  // Sort by points, then exact scores; tied players share a rank.
  function rankRows(rows) {
    rows.sort((a, b) => b.points - a.points || b.exact - a.exact || a.name.localeCompare(b.name));
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      r.rank = prev && prev.points === r.points && prev.exact === r.exact ? prev.rank : i + 1;
    });
    return rows;
  }

  const api = {
    LEAGUE, ESPN_SCOREBOARD, DEADLINE_MS, POINTS, MAX_GOALS, WINDOW_DAYS,
    ymd, days, isDates,
    normalizeEvent, normalizeScoreboard,
    groupMatchweeks, currentWeekIndex,
    deadlineOf, isOpen, validGoals, scorePrediction, leaderboard, rankRows,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (self.KOAS = self.KOAS || {}).core = api;
})();
