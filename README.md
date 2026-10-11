# KOAS Meda: Premier League Predictor

Predict the exact score of every Premier League game in the matchweek, earn
points when the final whistle goes, and climb the leaderboard. Fixtures and
live scores come from ESPN's public feed.

## Rules

1. **Sign up** with a name, email and password.
2. **Predict the exact score of every game** in the matchweek, then save. You
   can change predictions until they close.
3. **Predictions close 2 hours before the matchweek's first kick-off**, for all
   of that week's games at once. After that nothing can be added or changed,
   and other players' picks become visible.
4. **Points:** 3 for the exact score, 1 for the right result (home win, draw or
   away win) with the wrong score, 0 otherwise. Postponed or abandoned games
   score nothing.

The rules live in `public/core.js` (the app) and `supabase/schema.sql` (the
database, which enforces them). Change both together.

## Two modes

**Demo mode (default):** works straight away, including on GitHub Pages.
Accounts and predictions are saved in the visitor's browser only, so it's for
trying the app, not for a real competition.

**Live mode (Supabase):** real sign-up, predictions shared between everyone,
and a shared leaderboard. Free to set up:

1. Create a project at [supabase.com](https://supabase.com).
2. In the dashboard open **SQL Editor -> New query**, paste all of
   `supabase/schema.sql`, and press **Run**. This creates the tables and rules,
   loads the past week's and coming week's games from ESPN, and keeps them
   updated (today's games every minute, the rest every 30 minutes).
3. Open **Project Settings -> API** and copy the **Project URL** and the
   **anon public** key into `public/config.js`. Both are safe to publish.
4. Optional: under **Authentication -> Providers -> Email** you can turn off
   "Confirm email" if you don't want players to confirm their address.
5. Commit and push. The site switches to live mode automatically.

In live mode the database, not the browser, decides what's allowed: it rejects
predictions after the deadline, lets each player change only their own, hides
other players' picks until a game locks, and takes results only from ESPN.

## Run locally

Open `public/index.html` in a browser, or with Node.js 18+:

```bash
npm start          # http://localhost:3000, real ESPN data
npm run dev        # sample data (test/fixtures)
npm test
```

## Project layout

```
public/index.html   Page
public/app.js       Matchweek, save bar, leaderboard, sign-up
public/core.js      Rules: deadlines, scoring, matchweeks, ESPN parsing (shared with tests/server)
public/store.js     Accounts and data: Supabase, or demo mode in the browser
public/config.js    Supabase URL and anon key (empty = demo mode)
supabase/schema.sql Database tables, security rules, scoring and ESPN sync
server.js, src/     Optional Node server: static files + cached ESPN proxy
test/               node:test suites
```

> ESPN's feed is public but unofficial and can change without notice. Fixtures
> are grouped into matchweeks by kick-off time (ESPN doesn't publish matchweek
> numbers), so a rearranged game may appear in its own short week.
