// Premier League data and betting logic shared by the Node server (require)
// and the browser (window.KOAS.core). Pure functions only.
(() => {
  const LEAGUE = { key: 'epl', name: 'Premier League', sport: 'soccer', league: 'eng.1' };
  const ESPN_SCOREBOARD = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE.sport}/${LEAGUE.league}/scoreboard`;

  // ---- Dates -------------------------------------------------------------

  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

  // ESPN accepts a single day (YYYYMMDD) or a range (YYYYMMDD-YYYYMMDD).
  function dateRange(from, daysBack, daysAhead) {
    const start = new Date(from); start.setDate(start.getDate() - daysBack);
    const end = new Date(from); end.setDate(end.getDate() + daysAhead);
    return `${ymd(start)}-${ymd(end)}`;
  }

  const isDates = (s) => /^\d{8}(-\d{8})?$/.test(s);

  // ---- Odds --------------------------------------------------------------

  function num(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'string' && /^even/i.test(v.trim())) return 100;
    const n = Number(String(v).replace(/^[ou]/i, '').replace('+', ''));
    return Number.isFinite(n) && n !== 0 ? n : null;
  }

  function americanToDecimal(american) {
    const a = num(american);
    if (a == null || Math.abs(a) < 100) return null;
    return Math.round((a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a)) * 100) / 100;
  }

  // Standard UK fractional prices; the closest one is shown.
  const FRACTIONS = [
    [1, 10], [1, 8], [1, 6], [1, 5], [2, 9], [1, 4], [2, 7], [1, 3], [4, 11], [2, 5], [4, 9], [1, 2], [8, 15], [4, 7],
    [8, 13], [4, 6], [8, 11], [4, 5], [5, 6], [10, 11], [1, 1], [11, 10], [6, 5], [5, 4], [11, 8], [6, 4], [13, 8],
    [7, 4], [15, 8], [2, 1], [85, 40], [9, 4], [5, 2], [11, 4], [3, 1], [10, 3], [7, 2], [4, 1], [9, 2], [5, 1],
    [11, 2], [6, 1], [13, 2], [7, 1], [15, 2], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [14, 1], [16, 1], [18, 1],
    [20, 1], [25, 1], [33, 1], [40, 1], [50, 1], [66, 1], [80, 1], [100, 1],
  ];

  function formatOdds(decimal, format) {
    if (!decimal) return '–';
    if (format === 'american') {
      const a = decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
      return a > 0 ? `+${a}` : String(a);
    }
    if (format === 'fractional') {
      const target = decimal - 1;
      let best = FRACTIONS[0];
      for (const f of FRACTIONS) if (Math.abs(f[0] / f[1] - target) < Math.abs(best[0] / best[1] - target)) best = f;
      return best[0] === best[1] ? 'Evs' : `${best[0]}/${best[1]}`;
    }
    return decimal.toFixed(2);
  }

  // Reads the first odds entry on an ESPN competition. ESPN has used two shapes:
  // flat (homeTeamOdds.moneyLine, overUnder, overOdds) and nested
  // (moneyline.home.close.odds, total.over.close.line). Both are handled.
  function parseOdds(comp) {
    const o = comp && Array.isArray(comp.odds) ? comp.odds[0] : null;
    if (!o) return null;
    const pick = (node) => node && (node.close || node.current || node.open || node);
    const ml = o.moneyline || {};
    const tot = o.total || {};

    const home = americanToDecimal((o.homeTeamOdds && o.homeTeamOdds.moneyLine) ?? (pick(ml.home) || {}).odds);
    const away = americanToDecimal((o.awayTeamOdds && o.awayTeamOdds.moneyLine) ?? (pick(ml.away) || {}).odds);
    const draw = americanToDecimal((o.drawOdds && o.drawOdds.moneyLine) ?? (pick(ml.draw) || {}).odds);

    const overNode = pick(tot.over) || {};
    const underNode = pick(tot.under) || {};
    const line = num(o.overUnder) ?? num(overNode.line);
    const over = americanToDecimal(o.overOdds ?? overNode.odds);
    const under = americanToDecimal(o.underOdds ?? underNode.odds);

    const result = home && away && draw ? { home, draw, away } : null;
    const total = line && over && under ? { line, over, under } : null;
    if (!result && !total) return null;
    return { provider: (o.provider && o.provider.name) || null, result, total };
  }

  // ---- Scoreboard --------------------------------------------------------

  function normalizeTeam(c = {}) {
    const team = c.team || {};
    return {
      id: team.id || c.id || null,
      name: team.displayName || team.name || 'TBD',
      short: team.abbreviation || team.shortDisplayName || '',
      logo: team.logo || (team.logos && team.logos[0] && team.logos[0].href) || null,
      color: team.color ? `#${team.color}` : null,
      score: c.score != null && c.score !== '' ? Number(c.score) : null,
      form: c.form || null,
      record: (c.records && c.records[0] && c.records[0].summary) || null,
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
      description: type.description || '',
      clock: status.displayClock || null,
      venue: (comp.venue && comp.venue.fullName) || null,
      broadcast: (comp.broadcasts || []).flatMap((b) => b.names || []).join(', ') || null,
      home: normalizeTeam(home),
      away: normalizeTeam(away),
      odds: parseOdds(comp),
    };
  }

  function normalizeScoreboard(payload) {
    const events = (payload && payload.events) || [];
    return { events: events.map(normalizeEvent) };
  }

  // ---- Betting -----------------------------------------------------------

  const MARKETS = {
    result: { name: 'Match Result', outcomes: ['home', 'draw', 'away'] },
    total: { name: 'Total Goals', outcomes: ['over', 'under'] },
  };

  function selectionLabel(sel) {
    if (sel.market === 'result') return sel.outcome === 'draw' ? 'Draw' : sel.outcome === 'home' ? sel.home : sel.away;
    return `${sel.outcome === 'over' ? 'Over' : 'Under'} ${sel.line} goals`;
  }

  // Outcome of one selection once its match is over:
  // 'won' | 'lost' | 'void' (called off, or a push on a whole-number total), or null if not settled yet.
  function settleSelection(sel, event) {
    if (!event || event.state !== 'post') return null;
    if (!event.completed || event.home.score == null || event.away.score == null) return 'void';
    const h = event.home.score;
    const a = event.away.score;
    if (sel.market === 'result') {
      const actual = h > a ? 'home' : h < a ? 'away' : 'draw';
      return actual === sel.outcome ? 'won' : 'lost';
    }
    if (sel.market === 'total') {
      const goals = h + a;
      if (goals === sel.line) return 'void';
      return (goals > sel.line) === (sel.outcome === 'over') ? 'won' : 'lost';
    }
    return null;
  }

  // Settles a bet (single = one leg, accumulator = several) from its legs' results.
  // Returns { status: 'open'|'won'|'lost'|'void', payout }.
  function settleBet(bet) {
    const results = bet.legs.map((l) => l.result);
    if (results.includes('lost')) return { status: 'lost', payout: 0 };
    if (results.some((r) => !r)) return { status: 'open', payout: 0 };
    if (results.every((r) => r === 'void')) return { status: 'void', payout: bet.stake };
    const odds = bet.legs.reduce((p, l) => p * (l.result === 'won' ? l.odds : 1), 1);
    return { status: 'won', payout: Math.round(bet.stake * odds * 100) / 100 };
  }

  const combinedOdds = (legs) => Math.round(legs.reduce((p, l) => p * l.odds, 1) * 100) / 100;

  const api = {
    LEAGUE, ESPN_SCOREBOARD, MARKETS,
    ymd, dateRange, isDates,
    americanToDecimal, formatOdds, parseOdds,
    normalizeEvent, normalizeScoreboard,
    selectionLabel, settleSelection, settleBet, combinedOdds,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (self.KOAS = self.KOAS || {}).core = api;
})();
