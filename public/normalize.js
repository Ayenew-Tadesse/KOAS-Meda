(() => {
// Converts ESPN's verbose scoreboard payload into a compact shape the UI uses.

function normalizeCompetitor(c = {}) {
  const team = c.team || {};
  return {
    id: team.id || c.id || null,
    name: team.displayName || team.name || 'TBD',
    short: team.abbreviation || team.shortDisplayName || '',
    logo: team.logo || (team.logos && team.logos[0] && team.logos[0].href) || null,
    color: team.color ? `#${team.color}` : null,
    score: c.score != null && c.score !== '' ? String(c.score) : null,
    winner: Boolean(c.winner),
    record: (c.records && c.records[0] && c.records[0].summary) || null,
  };
}

function normalizeEvent(ev, leagueKey) {
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const status = ev.status || comp.status || {};
  const type = status.type || {};
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === 'home') || competitors[0];
  const away = competitors.find((c) => c.homeAway === 'away') || competitors[1];
  const broadcasts = (comp.broadcasts || []).flatMap((b) => b.names || []);

  return {
    id: String(ev.id),
    league: leagueKey,
    name: ev.name || '',
    date: ev.date || comp.date || null,
    // ESPN uses state "pre" (scheduled), "in" (live), "post" (final).
    state: type.state || 'pre',
    detail: type.shortDetail || type.detail || type.description || '',
    clock: status.displayClock || null,
    period: status.period || 0,
    venue: (comp.venue && comp.venue.fullName) || null,
    broadcast: broadcasts.join(', ') || null,
    home: normalizeCompetitor(home),
    away: normalizeCompetitor(away),
  };
}

function normalizeScoreboard(payload, leagueKey) {
  const events = (payload && payload.events) || [];
  const league = (payload && payload.leagues && payload.leagues[0]) || {};
  return {
    league: leagueKey,
    leagueName: league.name || league.abbreviation || leagueKey,
    events: events.map((e) => normalizeEvent(e, leagueKey)),
  };
}

// Shared by the Node server (require) and the browser (window.KOAS).
if (typeof module !== 'undefined' && module.exports) module.exports = { normalizeScoreboard, normalizeEvent };
else (self.KOAS = self.KOAS || {}).normalize = { normalizeScoreboard, normalizeEvent };
})();
