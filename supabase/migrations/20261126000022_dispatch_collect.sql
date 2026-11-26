-- GitHub starts the scheduled "Hourly collect" workflow only ~3 times a day (it drops schedules
-- when busy). Since the app's forecast now comes from that job (migration 20), Supabase starts
-- it instead: every 3 hours at :07 UTC, pg_cron calls GitHub's "run workflow" API
-- (workflow_dispatch) through pg_net. GitHub's own hourly schedule stays as a bonus; the
-- workflow's concurrency group stops two runs from overlapping.
--
-- BEFORE running this file, store the GitHub token in Vault (SQL editor, once; the token never
-- goes in a file or in git):
--   select vault.create_secret('<the token>', 'github_actions_token',
--                              'Starts surf-app workflows (Actions: read and write)');
-- The token: GitHub > Settings > Developer settings > Fine-grained tokens > Generate:
--   only repository perepages/surf-app, permission "Actions: Read and write", nothing else.
-- New token later (it expires): select vault.update_secret(
--   (select id from vault.secrets where name = 'github_actions_token'), '<new token>');
--
-- Check it works (pg_net keeps answers ~6 h; 204 = GitHub started the run):
--   select public.dispatch_collect();   -- start one now
--   select id, status_code, left(content, 200), created from net._http_response order by id desc limit 5;
--   select * from cron.job_run_details order by start_time desc limit 5;
-- Stop it:  select cron.unschedule('dispatch-collect');
-- Safe to run again.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.dispatch_collect()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_actions_token';
  if token is null or token = '' then
    raise exception 'Vault secret github_actions_token is missing (see migration 22)';
  end if;
  return net.http_post(
    url := 'https://api.github.com/repos/perepages/surf-app/actions/workflows/collect.yml/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'surf-app-scheduler',
      'Content-Type', 'application/json'),
    timeout_milliseconds := 10000
  );
end;
$$;

revoke all on function public.dispatch_collect() from public, anon, authenticated;
grant execute on function public.dispatch_collect() to service_role;

-- Every 3 hours at :07 UTC (00:07, 03:07, ... 21:07). Re-running replaces the schedule.
select cron.schedule('dispatch-collect', '7 */3 * * *', 'select public.dispatch_collect()');
