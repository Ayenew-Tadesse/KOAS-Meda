# KOAS Meda — Live Sports Scores

A lightweight web app that shows live, upcoming, and final scores across major
leagues, pulled in real time from ESPN's public scoreboard feed. No API key and
no npm dependencies required.

**Leagues:** NFL, College Football, NBA, WNBA, NCAA Men's Basketball, MLB, NHL,
Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, MLS.

## Features

- Live games first, with a pulsing **LIVE** marker, game clock/period, and a
  highlight flash whenever a score changes
- Filter by **All / Live / Upcoming / Final**, and browse any date
- Auto-refresh: every 15s while a game is live, every 60s otherwise; pauses
  when the tab is hidden
- Venue, TV broadcast, and team records
- Server-side caching (15s) so many viewers cost one upstream request, and
  stale data is shown if the feed briefly fails
- Responsive layout with light and dark mode

## Run it

**Quickest:** open `public/index.html` in your browser (double-click it). With
no server running, the page fetches scores straight from ESPN. You can also
host it on any static host. On GitHub Pages (Settings → Pages → Deploy from a
branch, folder `/ (root)`) the site lives at
https://ayenew-tadesse.github.io/KOAS-Meda/ and the root `index.html` forwards to
the app.

**With the Node server** (adds caching and keeps working if ESPN briefly fails).
Requires Node.js 18+:

```bash
npm start          # http://localhost:3000, real ESPN data
npm run dev        # offline mode with sample data (test/fixtures)
npm test
```

Environment variables: `PORT` (default 3000), `CACHE_TTL_MS` (default 15000),
`MOCK=1` for sample data.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/leagues` | Supported leagues |
| `GET /api/scoreboard?league=nba&date=YYYYMMDD` | Normalized games for a league (date optional, defaults to today) |

## Project layout

```
server.js           HTTP server: static files + JSON API
src/espn.js         Server-side ESPN fetcher with caching
public/leagues.js   League list (add more here; shared by server and browser)
public/normalize.js ESPN payload -> compact game objects (shared)
public/             Frontend (HTML/CSS/vanilla JS)
test/               node:test suites + sample fixture
```

To add a league, append an entry to `public/leagues.js` using ESPN's
`{sport}/{league}` slug, e.g.
`{ key: 'eredivisie', name: 'Eredivisie', sport: 'soccer', league: 'ned.1' }`.

> ESPN's scoreboard endpoint is public but unofficial and can change without
> notice. For a commercial product, consider a licensed provider such as
> API-Sports or Sportradar — only `src/espn.js` and `public/normalize.js` would
> need to change.
