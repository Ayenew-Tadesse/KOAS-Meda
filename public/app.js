(() => {
  const LIVE_REFRESH_MS = 15000; // when a game is in progress
  const IDLE_REFRESH_MS = 60000; // when nothing is live
  const LIVE_COUNT_MAX_AGE_MS = 120000; // how stale the Live badge may get off the home view
  const STATE_ORDER = { in: 0, pre: 1, post: 2 };
  const STATE_LABEL = { in: 'LIVE', pre: 'Upcoming', post: 'Final' };

  const $ = (sel) => document.querySelector(sel);
  const els = {
    leagues: $('#leagues'),
    games: $('#games'),
    status: $('#status'),
    date: $('#date'),
    liveCount: $('#live-count'),
  };

  const ALL = 'all'; // league key meaning "every league"

  const state = {
    league: ALL, // the home page shows every league
    filter: 'all',
    date: '', // '' = today
    data: null,
    prevScores: new Map(),
    timer: null,
    loading: false,
    leagues: [],
    // Live-game count across every league for the Live badge, kept fresh
    // in the background while a single league or another date is shown.
    liveCount: 0,
    liveCountAt: 0,
  };

  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Data source: our Node server's /api when it's running, otherwise ESPN
  // directly from the browser (e.g. index.html opened from disk or a static host).
  const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
  let mode = location.protocol === 'file:' ? 'direct' : null;

  async function fetchLeagues() {
    if (mode !== 'direct') {
      try {
        const res = await fetch('api/leagues');
        const body = await res.json();
        if (res.ok && Array.isArray(body)) { mode = 'server'; return body; }
      } catch { /* no server; fall through */ }
      mode = 'direct';
    }
    return KOAS.leagues.LEAGUES;
  }

  async function fetchScoreboard(leagueKey, date) {
    if (mode === 'server') {
      const params = new URLSearchParams({ league: leagueKey });
      if (date) params.set('date', date);
      const res = await fetch(`api/scoreboard?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    }
    const league = KOAS.leagues.byKey[leagueKey];
    const url = new URL(`${ESPN_BASE}/${league.sport}/${league.league}/scoreboard`);
    if (date) url.searchParams.set('dates', date);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
    const data = KOAS.normalize.normalizeScoreboard(await res.json(), leagueKey);
    return { ...data, leagueName: league.name, updatedAt: new Date().toISOString() };
  }

  async function loadLeagues() {
    state.leagues = await fetchLeagues();
    const chips = [{ key: ALL, name: 'All leagues' }, ...state.leagues].map((l) => {
      const b = el('button', l.key === state.league ? 'active' : '', l.name);
      b.type = 'button';
      b.dataset.key = l.key;
      b.addEventListener('click', () => {
        if (l.key !== ALL && state.filter === 'in') setFilter('all'); // Live spans every league
        selectLeague(l.key);
      });
      return b;
    });
    els.leagues.replaceChildren(...chips);
  }

  function selectLeague(key) {
    if (key === state.league) return;
    state.league = key;
    state.prevScores.clear();
    els.leagues.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
    els.games.replaceChildren(el('div', 'empty', key === ALL ? 'Loading every league…' : 'Loading…'));
    refresh();
  }

  // Loads one league, or every league in parallel; games carry their league.
  async function loadScope(leagueKey, date) {
    const keys = leagueKey === ALL ? state.leagues.map((l) => l.key) : [leagueKey];
    const results = await Promise.allSettled(keys.map((k) => fetchScoreboard(k, date)));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length) throw results[0].reason;
    const order = Object.fromEntries(state.leagues.map((l, i) => [l.key, i]));
    return {
      events: ok.flatMap((sb) => sb.events.map((e) => ({ ...e, leagueKey: sb.league, leagueName: sb.leagueName, leagueOrder: order[sb.league] ?? 99 }))),
      leagueName: leagueKey === ALL ? 'any league' : ok[0].leagueName,
      leaguesLoaded: ok.length,
      failed: results.length - ok.length,
      stale: ok.some((sb) => sb.stale),
      updatedAt: ok.map((sb) => sb.updatedAt).sort()[0],
    };
  }

  const countLive = (events) => events.filter((e) => e.state === 'in').length;

  async function refresh() {
    clearTimeout(state.timer);
    if (state.loading) { state.again = true; return; } // re-run once the current request ends
    state.loading = true;
    const { league, date } = state;
    try {
      const showingAllToday = league === ALL && !date;
      const badgeSweep = !showingAllToday && Date.now() - state.liveCountAt > LIVE_COUNT_MAX_AGE_MS
        ? loadScope(ALL, '').then((d) => { state.liveCount = countLive(d.events); state.liveCountAt = Date.now(); renderLiveCount(); }, () => {})
        : null;
      const body = await loadScope(league, date ? date.replaceAll('-', '') : '');
      if (league !== state.league || date !== state.date) return; // selection changed mid-request
      state.data = body;
      if (showingAllToday) { state.liveCount = countLive(body.events); state.liveCountAt = Date.now(); }
      render();
      const t = new Date(body.updatedAt).toLocaleTimeString();
      let msg = body.stale ? `Showing cached data from ${t} (source unavailable)` : `Updated ${t}`;
      if (league === ALL) msg = `${body.events.length} games in ${body.leaguesLoaded} leagues · ${msg}`;
      if (body.failed) msg += ` · ${body.failed} league${body.failed > 1 ? 's' : ''} couldn't load`;
      setStatus(msg, body.stale);
      await badgeSweep;
    } catch (err) {
      const reason = err instanceof TypeError ? 'network error, check your connection' : err.message;
      setStatus(`Couldn't load scores (${reason})`, true);
      if (!state.data) els.games.replaceChildren(el('div', 'empty', 'Scores are unavailable right now. Retrying…'));
    } finally {
      state.loading = false;
      if (state.again) { state.again = false; refresh(); } else schedule();
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    if (document.hidden) return; // resume on visibilitychange
    const anyLive = state.data && countLive(state.data.events) > 0;
    state.timer = setTimeout(refresh, anyLive ? LIVE_REFRESH_MS : IDLE_REFRESH_MS);
  }

  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.classList.toggle('error', Boolean(isError));
  }

  function teamRow(team, game) {
    const row = el('div', 'team');
    if (game.state === 'post' && !team.winner && (game.home.winner || game.away.winner)) row.classList.add('loser');

    if (team.logo) {
      const img = el('img');
      img.src = team.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.replaceWith(badge(team));
      row.append(img);
    } else {
      row.append(badge(team));
    }

    const name = el('div', 'name', team.name);
    if (team.record) name.append(el('span', 'record', team.record));
    row.append(name);

    const score = el('div', 'score', game.state === 'pre' ? '' : (team.score ?? '-'));
    const key = `${game.id}:${team.id}`;
    const prev = state.prevScores.get(key);
    if (prev != null && team.score != null && prev !== team.score) score.classList.add('flash');
    if (team.score != null) state.prevScores.set(key, team.score);
    row.append(score);
    return row;
  }

  function badge(team) {
    const b = el('div', 'badge', (team.short || team.name || '?').slice(0, 3));
    if (team.color) b.style.background = team.color;
    return b;
  }

  function leagueLink(g) {
    const link = el('button', 'league-link', g.leagueName);
    link.type = 'button';
    link.title = `Show only ${g.leagueName}`;
    link.addEventListener('click', () => {
      if (state.filter === 'in') setFilter('all');
      selectLeague(g.leagueKey);
    });
    return link;
  }

  function gameCard(g) {
    const card = el('article', `card ${g.state}`);
    const meta = el('div', 'meta');
    let when = g.detail;
    if (g.state === 'pre' && g.date) {
      when = new Date(g.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    }
    const label = g.state === 'in' ? `${STATE_LABEL.in} · ${g.detail}`
      : g.state === 'pre' ? when
      : g.detail || STATE_LABEL.post;
    meta.append(el('span', 'state', label));
    meta.append(state.league === ALL ? leagueLink(g) : el('span', '', g.state === 'pre' ? STATE_LABEL.pre : ''));
    card.append(meta, teamRow(g.away, g), teamRow(g.home, g));

    if (g.venue || g.broadcast) {
      const extra = el('div', 'extra');
      extra.append(el('span', '', g.venue || ''), el('span', '', g.broadcast ? `📺 ${g.broadcast}` : ''));
      card.append(extra);
    }
    return card;
  }

  function renderLiveCount() {
    els.liveCount.textContent = state.liveCount ? String(state.liveCount) : '';
  }

  function render() {
    renderLiveCount();
    document.body.classList.toggle('live-mode', state.filter === 'in');
    const events = (state.data && state.data.events) || [];
    const shown = events
      .filter((e) => state.filter === 'all' || e.state === state.filter)
      .sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3)
        || a.leagueOrder - b.leagueOrder
        || new Date(a.date) - new Date(b.date));

    if (!shown.length) {
      const what = { all: 'games', in: 'live games right now', pre: 'upcoming games', post: 'finished games' }[state.filter];
      const where = state.data ? state.data.leagueName : 'this league';
      const when = state.filter === 'in' ? '' : ' on this date';
      els.games.replaceChildren(el('div', 'empty', `No ${what} in ${where}${when}.`));
      return;
    }
    els.games.replaceChildren(...shown.map(gameCard));
  }

  function setFilter(filter) {
    state.filter = filter;
    document.querySelectorAll('.filters button').forEach((x) => x.classList.toggle('active', x.dataset.filter === filter));
  }

  document.querySelectorAll('.filters button').forEach((b) => b.addEventListener('click', () => {
    setFilter(b.dataset.filter);
    // Live means every league, right now.
    if (b.dataset.filter === 'in' && (state.league !== ALL || state.date)) {
      state.date = '';
      els.date.value = todayIso();
      if (state.league !== ALL) return selectLeague(ALL);
      els.games.replaceChildren(el('div', 'empty', 'Loading every league…'));
      return refresh();
    }
    render();
  }));

  els.date.value = todayIso();
  els.date.addEventListener('change', () => {
    if (state.filter === 'in') setFilter('all'); // Live is always "right now"
    state.date = els.date.value === todayIso() ? '' : els.date.value;
    state.prevScores.clear();
    refresh();
  });
  $('#today').addEventListener('click', () => {
    if (state.filter === 'in') setFilter('all');
    els.date.value = todayIso();
    state.date = '';
    refresh();
  });
  $('#refresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  loadLeagues()
    .then(refresh)
    .catch((err) => setStatus(`Couldn't load leagues: ${err.message}`, true));
})();
