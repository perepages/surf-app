-- What the app may show about the AI model. Apply after migrations 8 and 11. Safe to run again.
--
-- 1. models: how many ratings (and spots) a model learned from, written by jobs/train.py.
-- 2. spot_model_info(p_spot_id, p_days): public summary for the app. Like the report functions
--    (migration 7/8) it runs as its owner and returns only counts: never ratings, device ids
--    or model files. `models` itself stays private.
--    "AI closer": over the last p_days days (1-60, default 14, same as the app's chart), every
--    non-hidden community/'me' rating (same device + time counted once) is matched with the
--    prediction for that hour (surfed_at rounded to the hour) that had an AI score. The AI
--    score is compared as the app shows it (rounded 1-5) with the simple score, by distance
--    to the surfer's 1-5. Hours where both are equally close count in neither.

alter table public.models add column if not exists n_ratings integer check (n_ratings >= 0);
alter table public.models add column if not exists n_spots integer check (n_spots >= 1);
alter table public.models add column if not exists scope text check (scope in ('spot', 'general'));

create or replace function public.spot_model_info(p_spot_id text, p_days integer default 14)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    with d as (
        select least(greatest(coalesce(p_days, 14), 1), 60) as days
    ),
    m as (
        select m.version, m.trained_at, m.n_ratings, m.n_spots, m.scope
        from models m
        join spots s on s.id = m.spot_id and s.active
        where m.spot_id = p_spot_id and m.is_active
        limit 1
    ),
    r as (
        select distinct on (coalesce(r.device_id, r.id::text), r.surfed_at)
               r.spot_id, r.overall, r.surfed_at
        from ratings r, d
        where r.spot_id = p_spot_id
          and not r.hidden
          and r.source in ('community', 'me')
          and r.surfed_at >= now() - make_interval(days => d.days)
        order by coalesce(r.device_id, r.id::text), r.surfed_at, r.id
    ),
    c as (
        select abs(least(5, greatest(1, round(p.ai_score::numeric))) - r.overall) as ai_miss,
               abs(p.simple_score - r.overall)                                  as simple_miss
        from r
        join predictions p
          on p.spot_id = r.spot_id
         and p.valid_at = date_trunc('hour', r.surfed_at + interval '30 minutes')
        where p.ai_score is not null
    )
    select json_build_object(
        'active',        exists (select 1 from m),
        'version',       (select version from m),
        'scope',         (select scope from m),
        'trained_at',    (select trained_at from m),
        'n_ratings',     (select n_ratings from m),
        'n_spots',       (select n_spots from m),
        'days',          (select days from d),
        'compared',      (select count(*) from c),
        'ai_closer',     (select count(*) from c where ai_miss < simple_miss),
        'simple_closer', (select count(*) from c where simple_miss < ai_miss)
    );
$$;

revoke all on function public.spot_model_info(text, integer) from public;
grant execute on function public.spot_model_info(text, integer) to anon, authenticated, service_role;
