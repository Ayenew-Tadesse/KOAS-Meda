(() => {
  const LIVE_REFRESH_MS = 15000; // when a game is in progress
  const IDLE_REFRESH_MS = 60000; // when nothing is live
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

  const store = {
    get(k, fallback) { try { return localStorage.getItem(k) || fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  const state = {
    league: store.get('league', 'nfl'),
    filter: 'all',
    date: '', // '' = today
    data: null,
    prevScores: new Map(),
    timer: null,
    loading: false,
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
    const leagues = await fetchLeagues();
    if (!leagues.some((l) => l.key === state.league)) state.league = leagues[0].key;
    els.leagues.replaceChildren(...leagues.map((l) => {
      const b = el('button', l.key === state.league ? 'active' : '', l.name);
      b.type = 'button';
      b.dataset.key = l.key;
      b.addEventListener('click', () => selectLeague(l.key));
      return b;
    }));
  }

  function selectLeague(key) {
    state.league = key;
    store.set('league', key);
    state.prevScores.clear();
    els.leagues.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
    els.games.replaceChildren(el('div', 'empty', 'Loading…'));
    refresh();
  }

  async function refresh() {
    clearTimeout(state.timer);
    if (state.loading) { state.again = true; return; } // re-run once the current request ends
    state.loading = true;
    const league = state.league;
    const date = state.date;
    try {
      const body = await fetchScoreboard(league, date ? date.replaceAll('-', '') : '');
      if (league !== state.league || date !== state.date) return; // selection changed mid-request
      state.data = body;
      render();
      const t = new Date(body.updatedAt).toLocaleTimeString();
      setStatus(body.stale ? `Showing cached data from ${t} (source unavailable)` : `Updated ${t}`, body.stale);
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
    const anyLive = state.data && state.data.events.some((e) => e.state === 'in');
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

  function gameCard(g) {
    const card = el('article', `card ${g.state}`);
    const meta = el('div', 'meta');
    let when = g.detail;
    if (g.state === 'pre' && g.date) {
      when = new Date(g.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    }
    meta.append(el('span', 'state', g.state === 'in' ? `${STATE_LABEL.in} · ${g.detail}` : STATE_LABEL[g.state] || g.detail));
    meta.append(el('span', '', g.state === 'in' ? '' : g.state === 'post' ? g.detail : when));
    card.append(meta, teamRow(g.away, g), teamRow(g.home, g));

    if (g.venue || g.broadcast) {
      const extra = el('div', 'extra');
      extra.append(el('span', '', g.venue || ''), el('span', '', g.broadcast ? `📺 ${g.broadcast}` : ''));
      card.append(extra);
    }
    return card;
  }

  function render() {
    const events = (state.data && state.data.events) || [];
    const live = events.filter((e) => e.state === 'in').length;
    els.liveCount.textContent = live ? String(live) : '';

    const shown = events
      .filter((e) => state.filter === 'all' || e.state === state.filter)
      .sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3) || new Date(a.date) - new Date(b.date));

    if (!shown.length) {
      const what = { all: 'games', in: 'live games', pre: 'upcoming games', post: 'finished games' }[state.filter];
      els.games.replaceChildren(el('div', 'empty', `No ${what} for ${state.data ? state.data.leagueName : 'this league'} on this date.`));
      return;
    }
    els.games.replaceChildren(...shown.map(gameCard));
  }

  document.querySelectorAll('.filters button').forEach((b) => b.addEventListener('click', () => {
    state.filter = b.dataset.filter;
    document.querySelectorAll('.filters button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));

  els.date.value = todayIso();
  els.date.addEventListener('change', () => {
    state.date = els.date.value === todayIso() ? '' : els.date.value;
    state.prevScores.clear();
    refresh();
  });
  $('#today').addEventListener('click', () => {
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
