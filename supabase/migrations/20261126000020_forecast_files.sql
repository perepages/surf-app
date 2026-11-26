-- The app stops calling Open-Meteo itself: the hourly job (jobs/collect_forecast.py) fetches each
-- spot once and publishes one compact JSON file per spot (+ one for the home screen) to the
-- private bucket `forecast-files`. The web app reads them through the Vercel function
-- web/api/forecast.ts, which Vercel's CDN caches, so many visitors cost one storage read.
--
-- Gaps between what the app shows and what `forecasts` stored:
--   is_day             hourly day/night flag (Open-Meteo), used by the app's hour rows and score
--   spot_sun_times     sunrise/sunset per local day, used by the app's day view and daylight
--                      checks (the jobs can read them here instead of asking Open-Meteo again)
-- Safe to run again.

alter table public.forecasts
  add column if not exists is_day boolean;

create table if not exists public.spot_sun_times (
  spot_id  text not null references public.spots(id) on delete cascade,
  day      date not null,                 -- local date at the spot
  sunrise  timestamptz,                   -- UTC
  sunset   timestamptz,                   -- UTC
  primary key (spot_id, day)
);
alter table public.spot_sun_times enable row level security;
-- No policies and no public grants: only the service key (jobs) reads and writes it.
revoke all on public.spot_sun_times from anon, authenticated;
grant select, insert, update, delete on public.spot_sun_times to service_role;

-- Private bucket: only the service key (job writes, Vercel function reads). Not public, so
-- nobody can skip Vercel's cache and run up Supabase egress by downloading it directly.
insert into storage.buckets (id, name, public)
values ('forecast-files', 'forecast-files', false)
on conflict (id) do nothing;
