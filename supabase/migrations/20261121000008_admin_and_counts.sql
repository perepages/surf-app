-- Admin tools + cookie-free usage counts. Apply after migration 7. Safe to run again.
--
-- 1. ratings.hidden: the admin page (/admin, via the Vercel function api/admin.ts with the
--    service key) can hide spam. Hidden ratings drop out of the public summaries below, and the
--    train job must skip them too. The public can't set it: their insert grant lists columns
--    (migration 6) and `hidden` isn't one of them.
-- 2. daily_counts: one row per UTC day and kind, a plain number. No ids, no IPs, no cookies.
--    The app adds 1 through count_event(); the public can't read or change the table.
--    Kinds: 'visit' (app opened in a browser tab), 'visit_app' (opened as the installed app),
--    'install' (browser reported an install; Chrome/Edge/Android only, iPhone never reports it).
--    Anyone with the public key can inflate these numbers: they're a rough guide, not proof.

-- ---------------------------------------------------------------------------
-- 1. Hide spam ratings
-- ---------------------------------------------------------------------------
alter table public.ratings add column if not exists hidden boolean not null default false;
alter table public.ratings add column if not exists hidden_at timestamptz;
create index if not exists ratings_created_idx on public.ratings (created_at desc);

-- Same functions as migration 7, plus "and not r.hidden".
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
          and not r.hidden
          and (r.surfed_at at time zone s.timezone)::date = (now() at time zone s.timezone)::date
    )
    select json_build_object(
        'count',       (select count(*) from r),
        'avg_overall', (select round(avg(overall)::numeric, 1) from r),
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
      and not r.hidden
      and r.surfed_at >= ((date_trunc('day', now() at time zone s.timezone)
                           - make_interval(days => least(greatest(p_days, 1), 60) - 1))
                          at time zone s.timezone)
    group by 1
    order by 1;
$$;

revoke all on function public.spot_reports_today(text) from public;
revoke all on function public.spot_daily_ratings(text, integer) from public;
grant execute on function public.spot_reports_today(text) to anon, authenticated, service_role;
grant execute on function public.spot_daily_ratings(text, integer) to anon, authenticated, service_role;

-- The admin function updates only these two columns (explicit, in case migration 4's default
-- grants were never applied).
grant select on public.ratings to service_role;
grant update (hidden, hidden_at) on public.ratings to service_role;

-- ---------------------------------------------------------------------------
-- 2. Daily usage counters
-- ---------------------------------------------------------------------------
create table if not exists public.daily_counts (
    day     date    not null,                       -- UTC day
    kind    text    not null check (kind in ('visit', 'visit_app', 'install')),
    count   integer not null default 0 check (count >= 0),
    primary key (day, kind)
);
alter table public.daily_counts enable row level security;   -- no policies: no direct public access
revoke all on public.daily_counts from public, anon, authenticated;
grant select, insert, update, delete on public.daily_counts to service_role;

-- Adds 1 to today's (UTC) counter. Unknown kinds do nothing. Returns nothing.
create or replace function public.count_event(p_kind text)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
    insert into daily_counts (day, kind, count)
    select (now() at time zone 'utc')::date, p_kind, 1
    where p_kind in ('visit', 'visit_app', 'install')
    on conflict (day, kind) do update set count = daily_counts.count + 1;
$$;

revoke all on function public.count_event(text) from public;
grant execute on function public.count_event(text) to anon, authenticated, service_role;
