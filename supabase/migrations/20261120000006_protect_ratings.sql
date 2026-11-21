-- Protect community ratings. Apply after migrations 4 and 5. Safe to run again.
--
-- 1. Insert-only for the public: no update, delete or truncate, ever.
-- 2. Only sessions from today or yesterday (spot local time), never in the future.
-- 3. Every community rating carries a device id; max 3 per device in any 24 hours.
-- 4. Reject answers that contradict each other.
-- The jobs (service key) are not limited by any of this except rule 4.

-- ---------------------------------------------------------------------------
-- Spot time zone, so "today" means today at the beach (config-driven, per spot).
-- ---------------------------------------------------------------------------
alter table public.spots
    add column if not exists timezone text not null default 'Europe/Madrid';

-- ---------------------------------------------------------------------------
-- 1. Privileges: start from nothing, then allow inserting the rating fields only.
--    (REVOKE ALL also clears column grants, so the list below is the complete set.)
-- ---------------------------------------------------------------------------
revoke all on public.ratings from anon, authenticated;
grant insert (spot_id, surfed_at, overall, wave_size, surface, crowd, comment,
              source, device_id, near_beach, forecast_shown, app_version)
    on public.ratings to anon, authenticated;
-- No select/update/delete grants and no policies for them: the public can't read, edit or
-- delete ratings, not even their own. Only the service key (jobs, SQL editor) can.

-- ---------------------------------------------------------------------------
-- 4. Contradictory answers. "Flat" waves can't make a Fun/Good/Epic session.
--    (Applies to every source, including the jobs.)
-- ---------------------------------------------------------------------------
alter table public.ratings drop constraint if exists ratings_flat_not_good;
alter table public.ratings
    add constraint ratings_flat_not_good
    check (not (wave_size = 'flat' and overall >= 3));

-- ---------------------------------------------------------------------------
-- 2 + 3a. Insert policy: recent session, at an active spot, with a device id.
-- ---------------------------------------------------------------------------
drop policy if exists "public can insert community ratings" on public.ratings;
create policy "public can insert community ratings"
    on public.ratings for insert to anon, authenticated
    with check (
        ratings.source = 'community'
        and ratings.forecast_shown is not null
        and ratings.device_id is not null
        and char_length(ratings.device_id) between 16 and 64
        and exists (
            select 1 from public.spots s
            where s.id = ratings.spot_id
              and s.active
              -- from yesterday 00:00 at the spot ...
              and ratings.surfed_at >= ((date_trunc('day', now() at time zone s.timezone)
                                         - interval '1 day') at time zone s.timezone)
              -- ... until now (1 h of slack for phones with a fast clock)
              and ratings.surfed_at <= now() + interval '1 hour'
        )
    );

-- ---------------------------------------------------------------------------
-- 3b. Rate limit: max 3 community ratings per device in any rolling 24 hours.
--     A trigger, because a policy can't count rows the public isn't allowed to read.
--     SECURITY DEFINER lets it count; the advisory lock stops 4 parallel inserts
--     from all seeing "2 so far".
-- ---------------------------------------------------------------------------
create or replace function public.ratings_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    recent integer;
begin
    if new.source <> 'community' then
        return new;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ratings:' || coalesce(new.device_id, ''), 0));
    select count(*) into recent
    from public.ratings
    where device_id = new.device_id
      and source = 'community'
      and created_at > now() - interval '24 hours';
    if recent >= 3 then
        raise exception 'rate_limit: max 3 ratings per device per day'
            using errcode = 'P0001', hint = 'Try again tomorrow.';
    end if;
    return new;
end;
$$;

-- Only the trigger runs it; nobody can call it through the API.
revoke all on function public.ratings_rate_limit() from public, anon, authenticated;

drop trigger if exists ratings_rate_limit on public.ratings;
create trigger ratings_rate_limit
    before insert on public.ratings
    for each row execute function public.ratings_rate_limit();

-- Makes the per-device count fast.
create index if not exists ratings_device_recent_idx
    on public.ratings (device_id, created_at desc)
    where source = 'community';
