// Leagues available through ESPN's public scoreboard endpoint:
// https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
const LEAGUES = [
  { key: 'nfl', name: 'NFL', sport: 'football', league: 'nfl' },
  { key: 'ncaaf', name: 'College Football', sport: 'football', league: 'college-football' },
  { key: 'nba', name: 'NBA', sport: 'basketball', league: 'nba' },
  { key: 'wnba', name: 'WNBA', sport: 'basketball', league: 'wnba' },
  { key: 'ncaam', name: 'NCAA Men\'s Basketball', sport: 'basketball', league: 'mens-college-basketball' },
  { key: 'mlb', name: 'MLB', sport: 'baseball', league: 'mlb' },
  { key: 'nhl', name: 'NHL', sport: 'hockey', league: 'nhl' },
  { key: 'epl', name: 'Premier League', sport: 'soccer', league: 'eng.1' },
  { key: 'laliga', name: 'La Liga', sport: 'soccer', league: 'esp.1' },
  { key: 'seriea', name: 'Serie A', sport: 'soccer', league: 'ita.1' },
  { key: 'bundesliga', name: 'Bundesliga', sport: 'soccer', league: 'ger.1' },
  { key: 'ligue1', name: 'Ligue 1', sport: 'soccer', league: 'fra.1' },
  { key: 'ucl', name: 'Champions League', sport: 'soccer', league: 'uefa.champions' },
  { key: 'mls', name: 'MLS', sport: 'soccer', league: 'usa.1' },
];

const byKey = Object.fromEntries(LEAGUES.map((l) => [l.key, l]));

module.exports = { LEAGUES, byKey };
