-- KOAS Meda: Premier League score predictions.
-- Run this whole file once in your Supabase project (SQL Editor -> New query -> Run).
-- It is safe to run again after edits.
--
-- Rules enforced here (keep in sync with public/core.js):
--   * predictions lock 2 hours before kick-off
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

-- Predictions ------------------------------------------------------------

create table if not exists public.predictions (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  fixture_id text not null references public.fixtures (id) on delete cascade,
  home_goals int not null check (home_goals between 0 and 20),
  away_goals int not null check (away_goals between 0 and 20),
  updated_at timestamptz not null default now(),
  primary key (user_id, fixture_id)
);

create or replace function public.fixture_open(fid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.fixtures f
    where f.id = fid and f.state = 'pre' and now() < f.kickoff - interval '2 hours'
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

create or replace function public.sync_fixtures() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare
  url text := 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?limit=200&dates='
    || to_char(now() - interval '14 days', 'YYYYMMDD') || '-' || to_char(now() + interval '35 days', 'YYYYMMDD');
  body jsonb;
  ev jsonb;
  home jsonb;
  away jsonb;
  st text;
  n int := 0;
begin
  select content::jsonb into body from extensions.http_get(url);
  for ev in select * from jsonb_array_elements(coalesce(body -> 'events', '[]'::jsonb)) loop
    select c into home from jsonb_array_elements(ev -> 'competitions' -> 0 -> 'competitors') c where c ->> 'homeAway' = 'home';
    select c into away from jsonb_array_elements(ev -> 'competitions' -> 0 -> 'competitors') c where c ->> 'homeAway' = 'away';
    st := coalesce(ev -> 'status' -> 'type' ->> 'state', 'pre');
    insert into public.fixtures as f (id, kickoff, home_team, away_team, home_score, away_score, state, completed, updated_at)
    values (
      ev ->> 'id',
      (ev ->> 'date')::timestamptz,
      coalesce(home -> 'team' ->> 'displayName', 'TBD'),
      coalesce(away -> 'team' ->> 'displayName', 'TBD'),
      case when st <> 'pre' then nullif(home ->> 'score', '')::int end,
      case when st <> 'pre' then nullif(away ->> 'score', '')::int end,
      st,
      coalesce((ev -> 'status' -> 'type' ->> 'completed')::boolean, false),
      now()
    )
    on conflict (id) do update set
      kickoff = excluded.kickoff, home_team = excluded.home_team, away_team = excluded.away_team,
      home_score = excluded.home_score, away_score = excluded.away_score,
      state = excluded.state, completed = excluded.completed, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.sync_fixtures() from public, anon, authenticated;

-- Refresh fixtures and results every 5 minutes, and once right now.
select cron.unschedule(jobid) from cron.job where jobname = 'koas-sync-fixtures';
select cron.schedule('koas-sync-fixtures', '*/5 * * * *', 'select public.sync_fixtures()');
select public.sync_fixtures();
