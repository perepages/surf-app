-- "Who called it" now compares the AI with the PHYSICS score (jobs/physics.py, migration 17),
-- the score the app shows without a model, instead of the old simple score. Hours written
-- before migration 17 (no physics_overall) still use simple_score. Both rounded 1-5 as shown.
-- Same function, same output keys ('simple_closer' = the rules alone were closer).
-- Apply after migration 17. Safe to run again.

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
               abs(least(5, greatest(1, round(coalesce(p.physics_overall, p.simple_score)::numeric)))
                   - r.overall)                                                 as simple_miss
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
