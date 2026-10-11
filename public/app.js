(() => {
  const core = KOAS.core;
  const LIVE_REFRESH_MS = 15000;
  const IDLE_REFRESH_MS = 60000;

  const $ = (sel) => document.querySelector(sel);
  const els = {
    banner: $('#demo-banner'),
    account: $('#account'),
    fixtures: $('#fixtures'),
    weekTitle: $('#week-title'),
    weekSummary: $('#week-summary'),
    prev: $('#prev-week'),
    next: $('#next-week'),
    savebar: $('#savebar'),
    saveMsg: $('#save-msg'),
    save: $('#save'),
    board: $('#leaderboard'),
    auth: $('#auth'),
  };

  const state = {
    store: KOAS.createStore(),
    user: null,
    tab: 'week',
    events: [],
    eventsById: {},
    weeks: [],
    weekId: null, // the matchweek on screen; null = the current one
    saved: {}, // { eventId: { home, away } } as stored
    draft: {}, // { eventId: { home: '2', away: '' } } unsaved edits
    saving: false,
    timer: null,
    lockTimer: null,
    message: null, // { text, kind } shown in the save bar
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtShort = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtLock = (d) => `${new Date(d).toLocaleDateString([], { weekday: 'short' })} ${fmtTime(d)}`;

  function fmtIn(ms) {
    if (ms <= 0) return 'now';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `in ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `in ${h}h ${m % 60}m`;
    return `in ${Math.floor(h / 24)} days`;
  }

  // ---- Data ---------------------------------------------------------------

  // With Supabase connected, fixtures come from the database (one request).
  // Otherwise from ESPN, one day per request: our Node server's /api when
  // it's running, else ESPN directly (GitHub Pages, or a file opened from disk).
  let source = location.protocol === 'file:' ? 'direct' : null;

  async function fetchDay(day) {
    if (source !== 'direct') {
      try {
        const res = await fetch(`api/scoreboard?dates=${day}`);
        const body = await res.json();
        if (res.ok && Array.isArray(body.events)) { source = 'server'; return body.events; }
      } catch { /* no server */ }
      source = 'direct';
    }
    const res = await fetch(`${core.ESPN_SCOREBOARD}?dates=${day}`);
    if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
    return core.normalizeScoreboard(await res.json()).events;
  }

  // Runs fn over items, a few at a time, so dozens of days don't flood ESPN.
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      }
    };
    await Promise.all(Array.from({ length: limit }, worker));
    return out;
  }

  async function fetchEvents() {
    if (state.store.fixtures) return state.store.fixtures();
    // First load: the past week and the coming week. After that only yesterday
    // and today can change, so just those are refreshed and merged in.
    const first = !state.events.length;
    const days = first ? core.days(new Date(), core.WINDOW_DAYS, core.WINDOW_DAYS) : core.days(new Date(), 1, 0);
    if (source === null) await fetchDay(days[0]).catch(() => {}); // settle server vs direct once
    const results = await mapLimit(days, 6, fetchDay);
    const ok = results.filter((r) => r.ok);
    if (!ok.length) throw results[0].e;
    const byId = first ? {} : { ...state.eventsById };
    for (const r of ok) for (const e of r.v) byId[e.id] = e;
    return Object.values(byId);
  }

  async function refresh() {
    clearTimeout(state.timer);
    try {
      const events = await fetchEvents();
      state.events = events;
      state.eventsById = Object.fromEntries(events.map((e) => [e.id, e]));
      state.weeks = core.groupMatchweeks(events);
      render();
    } catch (err) {
      const reason = err instanceof TypeError ? 'network error, check your connection' : err.message;
      if (!state.events.length) els.fixtures.replaceChildren(el('div', 'empty', `Couldn't load fixtures (${reason}). Retrying…`));
    } finally {
      if (!document.hidden) {
        const live = state.events.some((e) => e.state === 'in');
        state.timer = setTimeout(refresh, live ? LIVE_REFRESH_MS : IDLE_REFRESH_MS);
      }
    }
  }

  async function loadPredictions() {
    try {
      state.saved = await state.store.loadPredictions();
    } catch (err) {
      state.saved = {};
      setMessage(err.message, 'error');
    }
  }

  // ---- Matchweek ----------------------------------------------------------

  function currentWeek() {
    if (!state.weeks.length) return null;
    let i = state.weeks.findIndex((w) => w.id === state.weekId);
    if (i === -1) i = core.currentWeekIndex(state.weeks);
    return { week: state.weeks[i], index: i };
  }

  const valueOf = (id, side) => {
    const d = state.draft[id];
    if (d && d[side] !== undefined) return d[side];
    const s = state.saved[id];
    return s ? String(s[side]) : '';
  };

  function parsedPick(id) {
    const h = valueOf(id, 'home');
    const a = valueOf(id, 'away');
    if (h === '' || a === '') return null;
    const pick = { home: Number(h), away: Number(a) };
    return core.validGoals(pick.home) && core.validGoals(pick.away) ? pick : null;
  }

  const isDirty = (id) => {
    const pick = parsedPick(id);
    const s = state.saved[id];
    return Boolean(state.draft[id]) && (!s || !pick || s.home !== pick.home || s.away !== pick.away);
  };

  function crest(team) {
    if (team.logo) {
      const img = el('img');
      img.src = team.logo;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.replaceWith(fallbackCrest(team));
      return img;
    }
    return fallbackCrest(team);
  }

  function fallbackCrest(team) {
    const c = el('span', 'crest', (team.short || team.name).slice(0, 3));
    if (team.color) c.style.background = team.color;
    return c;
  }

  function teamCell(team, side) {
    const t = el('div', `team ${side}`);
    const nm = el('span', 'nm', team.name);
    const short = el('span', 'nm-short', team.short || team.name.slice(0, 3).toUpperCase());
    t.title = team.name;
    if (side === 'home') t.append(nm, short, crest(team));
    else t.append(crest(team), nm, short);
    return t;
  }

  function goalInput(ev, side) {
    const input = el('input', 'goal');
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.maxLength = 2;
    input.value = valueOf(ev.id, side);
    input.dataset.fid = ev.id;
    input.dataset.side = side;
    input.setAttribute('aria-label', `${side === 'home' ? ev.home.name : ev.away.name} goals`);
    input.classList.toggle('filled', input.value !== '');
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 2);
      if (input.value !== '' && Number(input.value) > core.MAX_GOALS) input.value = String(core.MAX_GOALS);
      state.draft[ev.id] = { home: valueOf(ev.id, 'home'), away: valueOf(ev.id, 'away'), [side]: input.value };
      input.classList.toggle('filled', input.value !== '');
      state.message = null;
      renderSavebar();
      // After a digit, move on to the next box so a whole week can be typed quickly.
      if (input.value.length === 1) {
        const all = [...els.fixtures.querySelectorAll('input.goal')];
        const next = all[all.indexOf(input) + 1];
        if (next) next.focus();
      }
    });
    input.addEventListener('focus', () => input.select());
    return input;
  }

  // The line under the score boxes: kick-off time before the game, the
  // minute or HT while it's on, FT (or why it was called off) after.
  function matchStatus(ev, open) {
    if (ev.state === 'pre') return el('span', `status ${open ? 'open' : 'locked'}`, `${open ? '' : '🔒 '}${fmtTime(ev.date)}`);
    if (ev.state === 'in') return el('span', 'status live', ev.detail || 'LIVE');
    if (!ev.completed) return el('span', 'status', `${ev.detail || 'Called off'} · no points`);
    return el('span', 'status', ev.detail || 'FT');
  }

  function fixtureRow(ev) {
    const open = core.isOpen(ev);
    const card = el('article', `fx ${ev.state}`);
    const mid = el('div', 'mid');

    if (open) {
      mid.append(goalInput(ev, 'home'), el('span', 'dash', '–'), goalInput(ev, 'away'));
    } else if (ev.state === 'pre') {
      mid.append(el('span', 'vs', 'vs'));
    } else {
      mid.append(el('span', 'score', `${ev.home.score ?? '-'} – ${ev.away.score ?? '-'}`));
    }
    card.append(teamCell(ev.home, 'home'), mid, teamCell(ev.away, 'away'), matchStatus(ev, open));

    if (!open && state.user) {
      const pickWrap = el('div', 'pick');
      const pick = state.saved[ev.id];
      pickWrap.append(el('span', '', pick ? `Your pick ${pick.home} – ${pick.away}` : 'No prediction'));
      const sc = core.scorePrediction(pick, ev);
      if (sc) pickWrap.append(el('span', `pts${sc.points ? '' : ' zero'}`, `+${sc.points}`));
      else if (ev.state === 'post' && ev.completed && !pick) pickWrap.append(el('span', 'pts zero', '+0'));
      card.append(pickWrap);
    }
    return card;
  }

  function renderWeek() {
    const cur = currentWeek();
    if (!cur) {
      els.weekTitle.textContent = 'Matchweek';
      els.weekSummary.textContent = '';
      els.fixtures.replaceChildren(el('div', 'empty', 'No Premier League games in the past week or the coming week.'));
      els.prev.disabled = els.next.disabled = true;
      renderSavebar();
      return;
    }
    const { week, index } = cur;
    els.prev.disabled = index === 0;
    els.next.disabled = index === state.weeks.length - 1;
    const sameDay = fmtShort(week.start) === fmtShort(week.end);
    els.weekTitle.textContent = sameDay ? fmtShort(week.start) : `${fmtShort(week.start)} – ${fmtShort(week.end)}`;
    els.weekSummary.textContent = weekSummary(week);

    // Keep focus on the box being typed in across re-renders.
    const active = document.activeElement;
    const focus = active && active.dataset && active.dataset.fid ? { ...active.dataset } : null;

    const days = [];
    for (const ev of week.events) {
      const label = fmtDay(ev.date);
      let day = days[days.length - 1];
      if (!day || day.label !== label) days.push(day = { label, events: [] });
      day.events.push(ev);
    }
    els.fixtures.replaceChildren(...days.map((d) => {
      const wrap = el('div', 'day');
      const list = el('div', 'day-cards');
      list.append(...d.events.map(fixtureRow));
      wrap.append(el('h3', '', d.label), list);
      return wrap;
    }));

    if (focus) {
      const again = [...els.fixtures.querySelectorAll('input.goal')]
        .find((i) => i.dataset.fid === focus.fid && i.dataset.side === focus.side);
      if (again) again.focus();
    }
    renderSavebar();
    scheduleLockCheck(week);
  }

  function weekSummary(week) {
    const open = week.events.filter((e) => core.isOpen(e));
    const parts = [`${week.events.length} games`];
    if (state.user) {
      const done = week.events.map((e) => core.scorePrediction(state.saved[e.id], e)).filter(Boolean);
      if (done.length) parts.push(`${done.reduce((n, s) => n + s.points, 0)} pts so far`);
    }
    if (open.length) {
      const close = week.lockAt.getTime();
      parts.push(`predictions close ${fmtLock(close)} (${fmtIn(close - Date.now())})`);
    } else if (week.events.every((e) => e.state === 'post')) {
      parts.push('finished');
    } else {
      parts.push('predictions closed');
    }
    return parts.join(' · ');
  }

  // Re-render the moment the matchweek in view closes.
  function scheduleLockCheck(week) {
    clearTimeout(state.lockTimer);
    const waits = week.events.filter((e) => core.isOpen(e)).map((e) => core.deadlineOf(e).getTime() - Date.now());
    if (!waits.length) return;
    state.lockTimer = setTimeout(renderWeek, Math.min(Math.max(Math.min(...waits) + 500, 1000), 2 ** 31 - 1));
  }

  // ---- Save bar ------------------------------------------------------------

  function setMessage(text, kind) {
    state.message = text ? { text, kind } : null;
    renderSavebar();
  }

  function renderSavebar() {
    const cur = currentWeek();
    const open = cur ? cur.week.events.filter((e) => core.isOpen(e)) : [];
    els.savebar.hidden = state.tab !== 'week' || !open.length;
    if (els.savebar.hidden) return;

    const filled = open.filter((e) => parsedPick(e.id)).length;
    const dirty = open.some((e) => isDirty(e.id));
    let text;
    let kind = '';
    if (state.message) ({ text, kind } = state.message);
    else if (filled < open.length) text = open.length === 1 ? 'Predict the open game to save' : `Predict all ${open.length} open games to save (${filled}/${open.length} done)`;
    else if (!state.user) text = 'All set. Sign up to save your predictions.';
    else if (dirty) text = 'All games predicted. Save to lock them in.';
    else { text = `${open.length === 1 ? 'Prediction' : `All ${open.length} predictions`} saved. You can change ${open.length === 1 ? 'it' : 'them'} until ${fmtLock(cur.week.lockAt)}.`; kind = 'ok'; }

    els.saveMsg.textContent = text;
    els.saveMsg.className = `save-msg ${kind}`;
    els.save.textContent = state.user ? (state.saving ? 'Saving…' : 'Save predictions') : 'Sign up to save';
    els.save.disabled = state.saving || Boolean(state.user && (filled < open.length || !dirty));
  }

  async function save() {
    if (!state.user) return openAuth('signup');
    const cur = currentWeek();
    const open = cur.week.events.filter((e) => core.isOpen(e));
    const picks = open.map((e) => ({ id: e.id, pick: parsedPick(e.id) }));
    if (picks.some((p) => !p.pick)) return setMessage('Predict every open game first.', 'error');

    state.saving = true;
    renderSavebar();
    try {
      await state.store.savePredictions(picks.map((p) => ({ id: p.id, ...p.pick })), state.eventsById);
      for (const p of picks) {
        state.saved[p.id] = p.pick;
        delete state.draft[p.id];
      }
      state.saving = false;
      setMessage(`Saved ${picks.length} prediction${picks.length === 1 ? '' : 's'}.`, 'ok');
      setTimeout(() => { if (state.message && state.message.kind === 'ok') setMessage(null); }, 4000);
    } catch (err) {
      state.saving = false;
      await loadPredictions();
      renderWeek();
      setMessage(err.message, 'error');
    }
  }

  // ---- Leaderboard ----------------------------------------------------------

  async function renderBoard() {
    if (state.store.kind === 'supabase' && !state.user) {
      const wrap = el('div', 'empty');
      const btn = el('button', 'primary', 'Sign in');
      btn.type = 'button';
      btn.addEventListener('click', () => openAuth('signin'));
      wrap.append(el('p', '', 'Sign in to see the leaderboard.'), btn);
      els.board.replaceChildren(wrap);
      return;
    }
    if (!els.board.querySelector('table')) els.board.replaceChildren(el('div', 'empty', 'Loading…'));
    let rows;
    try {
      rows = await state.store.leaderboard(state.events);
    } catch (err) {
      els.board.replaceChildren(el('div', 'empty', `Couldn't load the leaderboard (${err.message}).`));
      return;
    }
    if (!rows.length) {
      els.board.replaceChildren(el('div', 'empty', 'No players yet. Sign up and be the first.'));
      return;
    }
    const table = el('table', 'board');
    const thead = el('thead');
    const head = el('tr');
    ['#', 'Player', 'Pts', 'Exact', 'Results', 'Played'].forEach((h) => head.append(el('th', '', h)));
    thead.append(head);
    const body = el('tbody');
    for (const r of rows) {
      const tr = el('tr', state.user && r.id === state.user.id ? 'me' : '');
      tr.append(el('td', '', String(r.rank)), el('td', '', r.name), el('td', 'points', String(r.points)),
        el('td', '', String(r.exact)), el('td', '', String(r.results)), el('td', '', String(r.scored)));
      body.append(tr);
    }
    table.append(thead, body);
    const wrap = el('div', 'board-wrap');
    wrap.append(table);
    const note = state.store.kind === 'demo' ? el('p', 'muted', 'Demo mode: only players who signed up in this browser are listed.') : null;
    els.board.replaceChildren(...[wrap, note].filter(Boolean));
  }

  // ---- Account -------------------------------------------------------------

  function button(text, cls, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function renderAccount() {
    if (state.user) {
      els.account.replaceChildren(el('span', 'who', state.user.name), button('Sign out', '', async () => {
        await state.store.signOut();
        state.user = null;
        state.saved = {};
        state.draft = {};
        render();
      }));
    } else {
      els.account.replaceChildren(button('Sign in', '', () => openAuth('signin')), button('Sign up', 'primary', () => openAuth('signup')));
    }
  }

  let authMode = 'signup';
  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('#name-row').hidden = mode !== 'signup';
    $('#auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    $('#auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('#auth-error').textContent = '';
  }

  function openAuth(mode) {
    setAuthMode(mode);
    if (typeof els.auth.showModal === 'function') els.auth.showModal();
    else els.auth.setAttribute('open', '');
    (mode === 'signup' ? $('#auth-name') : $('#auth-email')).focus();
  }

  function closeAuth() {
    if (typeof els.auth.close === 'function') els.auth.close();
    else els.auth.removeAttribute('open');
  }

  async function submitAuth(e) {
    e.preventDefault();
    const name = $('#auth-name').value.trim();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const err = $('#auth-error');
    if (authMode === 'signup' && (name.length < 2 || name.length > 24)) { err.textContent = 'Enter a name of 2 to 24 characters.'; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter a valid email address.'; return; }
    if (password.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }

    const btn = $('#auth-submit');
    btn.disabled = true;
    err.textContent = '';
    try {
      if (authMode === 'signup') {
        const res = await state.store.signUp({ name, email, password });
        if (res.needsConfirm) {
          setAuthMode('signin');
          err.textContent = 'Account created. Open the confirmation link we emailed you, then sign in here.';
          return;
        }
        state.user = res.user;
      } else {
        state.user = await state.store.signIn({ email, password });
      }
      $('#auth-password').value = '';
      closeAuth();
      await loadPredictions(); // scores typed before signing in are kept as drafts
      render();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Tabs & wiring -------------------------------------------------------

  function render() {
    renderAccount();
    if (state.tab === 'week') renderWeek();
    if (state.tab === 'table') renderBoard();
    renderSavebar();
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    ['week', 'table', 'rules'].forEach((t) => { $(`#tab-${t}`).hidden = t !== tab; });
    render();
  }

  function goWeek(delta) {
    const c = currentWeek();
    state.weekId = state.weeks[c.index + delta].id;
    state.message = null;
    renderWeek();
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  els.prev.addEventListener('click', () => goWeek(-1));
  els.next.addEventListener('click', () => goWeek(1));
  els.save.addEventListener('click', save);
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#auth-cancel').addEventListener('click', closeAuth);
  document.querySelectorAll('.auth-tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('beforeunload', (e) => {
    if (Object.keys(state.draft).some(isDirty)) { e.preventDefault(); e.returnValue = ''; }
  });

  $('#pts-exact').textContent = core.POINTS.exact;
  $('#pts-result').textContent = core.POINTS.result;

  (async () => {
    els.fixtures.replaceChildren(el('div', 'empty', 'Loading fixtures…'));
    try {
      state.user = await state.store.init();
    } catch (err) {
      setMessage(err.message, 'error');
    }
    els.banner.hidden = state.store.kind !== 'demo';
    await loadPredictions();
    renderAccount();
    await refresh();
  })();
})();
