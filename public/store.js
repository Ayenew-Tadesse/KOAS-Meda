// Accounts, predictions and the leaderboard. Two backends with one interface:
//   SupabaseStore - real sign-up and shared data (when public/config.js is filled in)
//   DemoStore     - everything in this browser's localStorage, for trying the app
(() => {
  const core = self.KOAS.core;
  const cfg = self.KOAS_CONFIG || {};

  class StoreError extends Error {}

  // ---- Demo (this browser only) -----------------------------------------

  const ls = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
  };

  async function hash(text) {
    if (self.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 0;
    for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
    return String(h);
  }

  class DemoStore {
    constructor() { this.kind = 'demo'; }
    users() { return ls.get('koas.users', {}); }

    async init() {
      const id = ls.get('koas.session', null);
      const u = id && Object.values(this.users()).find((x) => x.id === id);
      this.user = u ? { id: u.id, name: u.name } : null;
      return this.user;
    }

    async signUp({ name, email, password }) {
      const users = this.users();
      const key = email.trim().toLowerCase();
      if (users[key]) throw new StoreError('An account with this email already exists. Sign in instead.');
      const id = `demo-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      users[key] = { id, name: name.trim(), pass: await hash(`${key}:${password}`) };
      ls.set('koas.users', users);
      ls.set('koas.session', id);
      this.user = { id, name: name.trim() };
      return { user: this.user };
    }

    async signIn({ email, password }) {
      const u = this.users()[email.trim().toLowerCase()];
      if (!u || u.pass !== await hash(`${email.trim().toLowerCase()}:${password}`)) {
        throw new StoreError('Email or password is incorrect.');
      }
      ls.set('koas.session', u.id);
      this.user = { id: u.id, name: u.name };
      return this.user;
    }

    async signOut() { ls.del('koas.session'); this.user = null; }

    async loadPredictions() {
      return (this.user && ls.get('koas.predictions', {})[this.user.id]) || {};
    }

    async savePredictions(list, eventsById) {
      if (!this.user) throw new StoreError('Sign in to save predictions.');
      const late = list.filter((p) => !core.isOpen(eventsById[p.id]));
      if (late.length) throw new StoreError('Predictions for this matchweek closed before you saved, so nothing was saved.');
      const all = ls.get('koas.predictions', {});
      const mine = all[this.user.id] || {};
      for (const p of list) mine[p.id] = { home: p.home, away: p.away };
      all[this.user.id] = mine;
      ls.set('koas.predictions', all);
    }

    async leaderboard(events) {
      const preds = ls.get('koas.predictions', {});
      const byUser = {};
      for (const u of Object.values(this.users())) byUser[u.id] = { name: u.name, predictions: preds[u.id] || {} };
      return core.leaderboard(byUser, events);
    }
  }

  // ---- Supabase ---------------------------------------------------------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new StoreError('Could not load the sign-in service. Check your connection.'));
      document.head.append(s);
    });
  }

  function friendly(error) {
    const msg = (error && error.message) || String(error);
    if (/row-level security/i.test(msg)) return 'Predictions for this matchweek closed before you saved, so nothing was saved.';
    if (/foreign key/i.test(msg)) return 'A game isn\'t open for predictions yet. Try again in a few minutes.';
    if (/Invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
    if (/Email not confirmed/i.test(msg)) return 'Confirm your email first: open the link we sent you, then sign in.';
    if (/already registered/i.test(msg)) return 'An account with this email already exists. Sign in instead.';
    return msg;
  }

  class SupabaseStore {
    constructor() { this.kind = 'supabase'; }

    async init() {
      if (!self.supabase) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js');
      this.sb = self.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      const { data } = await this.sb.auth.getSession();
      this.user = data.session ? await this.profile(data.session.user) : null;
      return this.user;
    }

    async profile(authUser) {
      const { data } = await this.sb.from('profiles').select('display_name').eq('id', authUser.id).maybeSingle();
      const name = (data && data.display_name) || (authUser.user_metadata && authUser.user_metadata.display_name) || authUser.email;
      return { id: authUser.id, name };
    }

    async signUp({ name, email, password }) {
      const { data, error } = await this.sb.auth.signUp({ email, password, options: { data: { display_name: name.trim() } } });
      if (error) throw new StoreError(friendly(error));
      if (!data.session) return { needsConfirm: true }; // email confirmation is on
      this.user = await this.profile(data.user);
      return { user: this.user };
    }

    async signIn({ email, password }) {
      const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
      if (error) throw new StoreError(friendly(error));
      this.user = await this.profile(data.user);
      return this.user;
    }

    async signOut() { await this.sb.auth.signOut(); this.user = null; }

    async loadPredictions() {
      if (!this.user) return {};
      const { data, error } = await this.sb.from('predictions')
        .select('fixture_id, home_goals, away_goals').eq('user_id', this.user.id);
      if (error) throw new StoreError(friendly(error));
      return Object.fromEntries(data.map((r) => [r.fixture_id, { home: r.home_goals, away: r.away_goals }]));
    }

    async savePredictions(list) {
      if (!this.user) throw new StoreError('Sign in to save predictions.');
      const rows = list.map((p) => ({ user_id: this.user.id, fixture_id: p.id, home_goals: p.home, away_goals: p.away }));
      const { error } = await this.sb.from('predictions').upsert(rows, { onConflict: 'user_id,fixture_id' });
      if (error) throw new StoreError(friendly(error));
    }

    // Fixtures and scores from the database, which syncs them from ESPN.
    async fixtures() {
      const span = (core.WINDOW_DAYS + 1) * 24 * 3600 * 1000;
      const { data, error } = await this.sb.from('fixtures').select('*')
        .gte('kickoff', new Date(Date.now() - span).toISOString())
        .lte('kickoff', new Date(Date.now() + span).toISOString())
        .order('kickoff');
      if (error) throw new StoreError(friendly(error));
      const team = (r, side) => ({
        id: null,
        name: r[`${side}_team`],
        short: r[`${side}_short`] || '',
        logo: r[`${side}_logo`] || null,
        color: r[`${side}_color`] ? `#${r[`${side}_color`]}` : null,
        score: r[`${side}_score`],
      });
      return data.map((r) => ({
        id: r.id, date: r.kickoff, state: r.state, completed: r.completed,
        detail: r.detail || '', venue: r.venue, broadcast: r.broadcast,
        home: team(r, 'home'), away: team(r, 'away'),
      }));
    }

    async leaderboard() {
      const { data, error } = await this.sb.rpc('leaderboard');
      if (error) throw new StoreError(friendly(error));
      return core.rankRows(data.map((r) => ({
        id: r.user_id, name: r.display_name, points: Number(r.points),
        exact: Number(r.exact), results: Number(r.results), scored: Number(r.scored),
      })));
    }
  }

  self.KOAS.createStore = () => (cfg.supabaseUrl && cfg.supabaseAnonKey ? new SupabaseStore() : new DemoStore());
  self.KOAS.StoreError = StoreError;
})();
