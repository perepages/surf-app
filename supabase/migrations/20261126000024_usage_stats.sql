-- Free-plan usage for /admin (scaling item 5). Service key only (the /api/admin function and
-- the nightly limit check); nothing here is public.
--
--   api_calls        what our jobs asked external APIs per UTC day (written by the jobs:
--                    jobs/collect_forecast.py http() counts every Open-Meteo request with
--                    Open-Meteo's own weighting and adds it here when the job ends)
--   log_api_calls()  adds to today's row
--   usage_summary()  database size (same query as Supabase's docs), size of the biggest
--                    tables, file storage per bucket, API calls of the last 30 days
--
-- What can't be read from inside the database: Supabase egress (only on the dashboard; not in
-- the Management API either) and Vercel's numbers (only with a Vercel access token).
-- Safe to run again.

create table if not exists public.api_calls (
    day      date    not null,
    service  text    not null check (char_length(service) between 1 and 40),
    calls    numeric not null default 0,   -- weighted, as the service counts them
    requests integer not null default 0,   -- plain HTTP requests
    primary key (day, service)
);
alter table public.api_calls enable row level security;
revoke all on public.api_calls from public, anon, authenticated;
grant select, insert, update, delete on public.api_calls to service_role;

create or replace function public.log_api_calls(p_service text, p_calls numeric, p_requests integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.api_calls as a (day, service, calls, requests)
  values ((now() at time zone 'utc')::date, p_service, greatest(p_calls, 0), greatest(p_requests, 0))
  on conflict (day, service) do update
    set calls = a.calls + excluded.calls, requests = a.requests + excluded.requests;
$$;
revoke all on function public.log_api_calls(text, numeric, integer) from public, anon, authenticated;
grant execute on function public.log_api_calls(text, numeric, integer) to service_role;

create or replace function public.usage_summary()
returns json
language sql
security definer
set search_path = public, storage, pg_catalog
stable
as $$
  select json_build_object(
    'measured_at', now(),
    -- Supabase's own query for the 500 MB limit (docs: manage-your-usage/database-size).
    'db_bytes', (select sum(pg_database_size(datname))::bigint from pg_database),
    'tables', (
      select coalesce(json_agg(t order by t.bytes desc), '[]'::json) from (
        select c.relname as name,
               pg_total_relation_size(c.oid)::bigint as bytes,
               greatest(c.reltuples, 0)::bigint as rows_estimate
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by pg_total_relation_size(c.oid) desc
        limit 10) t),
    'storage', (
      select coalesce(json_agg(s order by s.bytes desc), '[]'::json) from (
        select bucket_id as bucket, count(*)::integer as files,
               coalesce(sum((metadata ->> 'size')::bigint), 0)::bigint as bytes
        from storage.objects group by bucket_id) s),
    'api_calls', (
      select coalesce(json_agg(a order by a.day desc, a.service), '[]'::json) from (
        select day, service, round(calls, 1) as calls, requests
        from public.api_calls
        where day > (now() at time zone 'utc')::date - 30) a)
  );
$$;
revoke all on function public.usage_summary() from public, anon, authenticated;
grant execute on function public.usage_summary() to service_role;
