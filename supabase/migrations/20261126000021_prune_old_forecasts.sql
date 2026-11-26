-- Forecast rows older than 90 days are deleted, except the ones training uses.
--
-- What training reads from `forecasts` (jobs/train.py): for each rating, the rows valid at the
-- rating hour (features) and the rows valid in the 72 h before it (wind 6/12/24 h, rain 72 h
-- history). Nothing else old is ever read (predict/notify/app use only the newest run), so
-- deleting it can't change the AI. Kept: rows of the same spot valid from surfed_at - 73 h to
-- surfed_at + 1 h (train rounds surfed_at to the nearest hour), for every rating that isn't
-- hidden as spam. Ratings sent later can't use older deleted rows anyway: they need the
-- forecast of the hour they surfed, which is recent.
--
-- Called by jobs/collect_forecast.py after thinning (service key only). Returns rows deleted.
-- At most p_limit rows per call, so one call never runs long; the next run continues.
-- Safe to run again.

create or replace function public.prune_old_forecasts(p_days integer default 90, p_limit integer default 20000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_days < 30 then
    raise exception 'p_days must be at least 30';
  end if;
  with doomed as (
    select f.ctid
    from public.forecasts f
    where f.fetched_at < now() - make_interval(days => p_days)
      and f.valid_at < now() - make_interval(days => p_days)
      and not exists (
        select 1 from public.ratings r
        where r.spot_id = f.spot_id
          and r.hidden is not true
          and f.valid_at >= r.surfed_at - interval '73 hours'
          and f.valid_at <= r.surfed_at + interval '1 hour'
      )
    limit p_limit
  )
  delete from public.forecasts f using doomed d where f.ctid = d.ctid;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.prune_old_forecasts(integer, integer) from public, anon, authenticated;
grant execute on function public.prune_old_forecasts(integer, integer) to service_role;

-- Count only (for --dry-run): same rule, nothing deleted.
create or replace function public.count_old_forecasts(p_days integer default 90)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
  from public.forecasts f
  where f.fetched_at < now() - make_interval(days => p_days)
    and f.valid_at < now() - make_interval(days => p_days)
    and not exists (
      select 1 from public.ratings r
      where r.spot_id = f.spot_id
        and r.hidden is not true
        and f.valid_at >= r.surfed_at - interval '73 hours'
        and f.valid_at <= r.surfed_at + interval '1 hour'
    );
$$;

revoke all on function public.count_old_forecasts(integer) from public, anon, authenticated;
grant execute on function public.count_old_forecasts(integer) to service_role;
