-- Public summaries of surfer reports. Apply after migration 6. Safe to run again.
--
-- Ratings stay unreadable for the public (migration 6). These two functions return only
-- aggregates plus the latest comment texts: never device ids, forecast copies, near_beach
-- or row ids. They run as their owner (SECURITY DEFINER) so they can read ratings.
-- Comments become public here; the privacy page and the rating form say so.
-- Counted sources: community ratings and my own ('me'); old imported sessions are not.

-- ---------------------------------------------------------------------------
-- Today's reports at a spot ("today" = spot local date of the session).
-- ---------------------------------------------------------------------------
create or replace function public.spot_reports_today(p_spot_id text)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with s as (
        select id, timezone from spots where id = p_spot_id and active
    ),
    r as (
        select r.overall, r.wave_size, r.crowd, r.comment, r.surfed_at, r.created_at
        from ratings r
        join s on s.id = r.spot_id
        where r.source in ('community', 'me')
          and (r.surfed_at at time zone s.timezone)::date = (now() at time zone s.timezone)::date
    )
    select json_build_object(
        'count',       (select count(*) from r),
        'avg_overall', (select round(avg(overall)::numeric, 1) from r),
        -- most common answer; ties go to the most recent
        'wave_size',   (select wave_size from r where wave_size is not null
                        group by wave_size order by count(*) desc, max(created_at) desc limit 1),
        'crowd',       (select crowd from r where crowd is not null
                        group by crowd order by count(*) desc, max(created_at) desc limit 1),
        'comments',    coalesce((
                           select json_agg(json_build_object('comment', c.comment,
                                                             'overall', c.overall,
                                                             'surfed_at', c.surfed_at)
                                           order by c.created_at desc)
                           from (select * from r
                                 where comment is not null and btrim(comment) <> ''
                                 order by created_at desc limit 5) c
                       ), '[]'::json)
    );
$$;

-- ---------------------------------------------------------------------------
-- Average rating per day for the last p_days days (1-60), for the forecast-vs-surfers chart.
-- ---------------------------------------------------------------------------
create or replace function public.spot_daily_ratings(p_spot_id text, p_days integer default 14)
returns table (day date, reports integer, avg_overall numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select (r.surfed_at at time zone s.timezone)::date as day,
           count(*)::integer                          as reports,
           round(avg(r.overall)::numeric, 2)          as avg_overall
    from ratings r
    join spots s on s.id = r.spot_id and s.active
    where r.spot_id = p_spot_id
      and r.source in ('community', 'me')
      and r.surfed_at >= ((date_trunc('day', now() at time zone s.timezone)
                           - make_interval(days => least(greatest(p_days, 1), 60) - 1))
                          at time zone s.timezone)
    group by 1
    order by 1;
$$;

-- Callable by the web app, nobody else needs them.
revoke all on function public.spot_reports_today(text) from public;
revoke all on function public.spot_daily_ratings(text, integer) from public;
grant execute on function public.spot_reports_today(text) to anon, authenticated, service_role;
grant execute on function public.spot_daily_ratings(text, integer) to anon, authenticated, service_role;
