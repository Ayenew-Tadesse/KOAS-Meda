-- KOAS Meda: Premier League score predictions.
-- Run this whole file once in your Supabase project (SQL Editor -> New query -> Run).
-- It is safe to run again after edits.
--
-- Rules enforced here (keep in sync with public/core.js):
--   * a matchweek's predictions close 2 hours before its first kick-off
--   * 3 points for the exact score, 1 for the right result (win/draw/loss)
--   * fixtures and results come from ESPN via sync_fixtures(), never from players

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

-- Players ----------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 24),
  created_at timestamptz not null default now()
);

-- A profile is created with every sign-up, from the name given at sign-up.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)), 24)
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Fixtures (written only by sync_fixtures) ---------------------------------

create table if not exists public.fixtures (
  id text primary key,                -- ESPN event id
  kickoff timestamptz not null,
  home_team text not null,
  away_team text not null,
  home_score int,
  away_score int,
  state text not null default 'pre',  -- pre | in | post
  completed boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Display details shown on the website (added in v2; safe to re-run).
alter table public.fixtures
  add column if not exists home_short text,
  add column if not exists away_short text,
  add column if not exists home_logo text,
  add column if not exists away_logo text,
  add column if not exists home_color text,
  add column if not exists away_color text,
  add column if not exists detail text,
  add column if not exists venue text,
  add column if not exists broadcast text;

-- Predictions ------------------------------------------------------------

create table if not exists public.predictions (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  fixture_id text not null references public.fixtures (id) on delete cascade,
  home_goals int not null check (home_goals between 0 and 20),
  away_goals int not null check (away_goals between 0 and 20),
  updated_at timestamptz not null default now(),
  primary key (user_id, fixture_id)
);

-- First kick-off of the matchweek a fixture belongs to. Matchweeks are runs
-- of fixtures with less than 36 hours between consecutive kick-offs (same
-- grouping as groupMatchweeks in public/core.js).
create or replace function public.round_start(fid text) returns timestamptz
language sql stable security definer set search_path = public as $$
  with ordered as (
    select id, kickoff,
      case when lag(kickoff) over w is null or kickoff - lag(kickoff) over w >= interval '36 hours' then 1 else 0 end as new_round
    from public.fixtures
    window w as (order by kickoff, id)
  ), rounds as (
    select id, kickoff, sum(new_round) over (order by kickoff, id) as round from ordered
  )
  select min(kickoff) from rounds where round = (select round from rounds where id = fid);
$$;

-- Predictions for a whole matchweek close 2 hours before its first kick-off.
create or replace function public.fixture_open(fid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.fixtures f
    where f.id = fid and f.state = 'pre' and now() < public.round_start(fid) - interval '2 hours'
  );
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists predictions_touch on public.predictions;
create trigger predictions_touch before update on public.predictions
  for each row execute function public.touch_updated_at();

-- Row level security -----------------------------------------------------

alter table public.profiles enable row level security;
alter table public.fixtures enable row level security;
alter table public.predictions enable row level security;

drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select to authenticated using (true);
drop policy if exists "rename yourself" on public.profiles;
create policy "rename yourself" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "fixtures readable" on public.fixtures;
create policy "fixtures readable" on public.fixtures for select to anon, authenticated using (true);

-- Your own predictions any time; other players' only once that game has locked.
drop policy if exists "read predictions" on public.predictions;
create policy "read predictions" on public.predictions for select to authenticated
  using (user_id = auth.uid() or not public.fixture_open(fixture_id));
drop policy if exists "predict before deadline" on public.predictions;
create policy "predict before deadline" on public.predictions for insert to authenticated
  with check (user_id = auth.uid() and public.fixture_open(fixture_id));
drop policy if exists "change before deadline" on public.predictions;
create policy "change before deadline" on public.predictions for update to authenticated
  using (user_id = auth.uid() and public.fixture_open(fixture_id))
  with check (user_id = auth.uid() and public.fixture_open(fixture_id));

-- Scoring ----------------------------------------------------------------

create or replace function public.prediction_points(ph int, pa int, h int, a int) returns int
language sql immutable as $$
  select case
    when ph = h and pa = a then 3
    when sign(ph - pa) = sign(h - a) then 1
    else 0
  end;
$$;

create or replace function public.leaderboard()
returns table (user_id uuid, display_name text, points bigint, exact bigint, results bigint, scored bigint)
language sql stable security definer set search_path = public as $$
  select pr.id, pr.display_name,
    coalesce(sum(public.prediction_points(p.home_goals, p.away_goals, f.home_score, f.away_score)), 0) as points,
    count(*) filter (where p.home_goals = f.home_score and p.away_goals = f.away_score) as exact,
    count(*) filter (where public.prediction_points(p.home_goals, p.away_goals, f.home_score, f.away_score) = 1) as results,
    count(f.id) as scored
  from public.profiles pr
  left join public.predictions p on p.user_id = pr.id
  left join public.fixtures f on f.id = p.fixture_id and f.completed and f.home_score is not null
  group by pr.id, pr.display_name
  order by points desc, exact desc, pr.display_name;
$$;

revoke all on function public.leaderboard() from public, anon;
grant execute on function public.leaderboard() to authenticated;

-- ESPN sync --------------------------------------------------------------
-- ESPN's scoreboard accepts one day per request (date ranges return 400),
-- so fixtures are fetched day by day.

drop function if exists public.sync_fixtures();

create or replace function public.sync_fixtures_day(day date) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare
  resp extensions.http_response;
  body jsonb;
  ev jsonb;
  comp jsonb;
  home jsonb;
  away jsonb;
  st text;
  n int := 0;
begin
  resp := extensions.http_get(
    'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=' || to_char(day, 'YYYYMMDD'));
  if resp.status <> 200 then
    raise warning 'ESPN returned % for %', resp.status, day;
    return 0;
  end if;
  body := resp.content::jsonb;
  for ev in select * from jsonb_array_elements(coalesce(body -> 'events', '[]'::jsonb)) loop
    comp := ev -> 'competitions' -> 0;
    select c into home from jsonb_array_elements(comp -> 'competitors') c where c ->> 'homeAway' = 'home';
    select c into away from jsonb_array_elements(comp -> 'competitors') c where c ->> 'homeAway' = 'away';
    st := coalesce(ev -> 'status' -> 'type' ->> 'state', 'pre');
    insert into public.fixtures as f (
      id, kickoff, home_team, away_team, home_score, away_score, state, completed,
      home_short, away_short, home_logo, away_logo, home_color, away_color, detail, venue, broadcast, updated_at)
    values (
      ev ->> 'id',
      (ev ->> 'date')::timestamptz,
      coalesce(home -> 'team' ->> 'displayName', 'TBD'),
      coalesce(away -> 'team' ->> 'displayName', 'TBD'),
      case when st <> 'pre' then nullif(home ->> 'score', '')::int end,
      case when st <> 'pre' then nullif(away ->> 'score', '')::int end,
      st,
      coalesce((ev -> 'status' -> 'type' ->> 'completed')::boolean, false),
      home -> 'team' ->> 'abbreviation',
      away -> 'team' ->> 'abbreviation',
      home -> 'team' ->> 'logo',
      away -> 'team' ->> 'logo',
      home -> 'team' ->> 'color',
      away -> 'team' ->> 'color',
      ev -> 'status' -> 'type' ->> 'shortDetail',
      comp -> 'venue' ->> 'fullName',
      (select string_agg(nm, ', ') from jsonb_array_elements(coalesce(comp -> 'broadcasts', '[]'::jsonb)) b,
         jsonb_array_elements_text(coalesce(b -> 'names', '[]'::jsonb)) nm),
      now()
    )
    on conflict (id) do update set
      kickoff = excluded.kickoff, home_team = excluded.home_team, away_team = excluded.away_team,
      home_score = excluded.home_score, away_score = excluded.away_score,
      state = excluded.state, completed = excluded.completed,
      home_short = excluded.home_short, away_short = excluded.away_short,
      home_logo = excluded.home_logo, away_logo = excluded.away_logo,
      home_color = excluded.home_color, away_color = excluded.away_color,
      detail = excluded.detail, venue = excluded.venue, broadcast = excluded.broadcast,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- Syncs every day from days_back before today to days_ahead after it.
-- A failing day is skipped (and logged) so it can't stop the rest.
create or replace function public.sync_fixtures(days_back int, days_ahead int) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare
  d date;
  n int := 0;
begin
  for d in select generate_series(current_date - days_back, current_date + days_ahead, interval '1 day')::date loop
    begin
      n := n + public.sync_fixtures_day(d);
    exception when others then
      raise warning 'sync for % failed: %', d, sqlerrm;
    end;
  end loop;
  return n;
end $$;

revoke all on function public.sync_fixtures_day(date) from public, anon, authenticated;
revoke all on function public.sync_fixtures(int, int) from public, anon, authenticated;

-- Today's games every minute (live scores); the coming week every 30 minutes.
select cron.unschedule(jobid) from cron.job where jobname in ('koas-sync-fixtures', 'koas-sync-live');
select cron.schedule('koas-sync-live', '* * * * *', 'select public.sync_fixtures(1, 0)');
select cron.schedule('koas-sync-fixtures', '*/30 * * * *', 'select public.sync_fixtures(2, 7)');

-- Load the past week and the coming week now. The number shown is how many games were loaded.
select public.sync_fixtures(7, 7) as games_loaded;
