-- Table privileges. Newer Supabase projects no longer grant access to new tables in
-- `public` automatically, so each role gets exactly what it needs here.
-- Row-level security (first migration) still filters what anon/authenticated can see or insert.

grant usage on schema public to anon, authenticated, service_role;

-- Jobs (service key): full access to every table and its id sequence.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Public (web app): read spots, forecasts, predictions; insert ratings. Nothing else.
grant select on public.spots, public.forecasts, public.predictions to anon, authenticated;
grant insert on public.ratings to anon, authenticated;
grant usage on sequence public.ratings_id_seq to anon, authenticated;
