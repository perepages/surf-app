-- Hardening after the Step 1-3 review.

-- 1. Future tables: migration 3 only granted tables that existed then. Without this, every new
--    table would give the jobs the same "403 permission denied" we hit before.
--    (Applies to tables created later by the same role that runs this, i.e. the SQL editor.)
alter default privileges in schema public
    grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
    grant usage, select on sequences to service_role;

-- 2. The public may only fill in rating fields, not created_at (which would let anyone backdate
--    rows). id is generated and can't be set anyway.
revoke insert on public.ratings from anon, authenticated;
grant insert (spot_id, surfed_at, overall, wave_size, surface, crowd, comment,
              source, device_id, near_beach, forecast_shown)
    on public.ratings to anon, authenticated;

-- 3. Cap the size of the forecast copy so nobody can store megabytes per anonymous insert.
alter table public.ratings
    add constraint ratings_forecast_shown_size
    check (forecast_shown is null or octet_length(forecast_shown::text) <= 16384);

-- 4. Community ratings must carry the forecast the user saw (the whole point of a rating).
--    Same policy as before plus that rule, with the column names fully qualified.
drop policy "public can insert community ratings" on public.ratings;
create policy "public can insert community ratings"
    on public.ratings for insert to anon, authenticated
    with check (
        ratings.source = 'community'
        and ratings.forecast_shown is not null
        and ratings.surfed_at between now() - interval '7 days' and now() + interval '1 hour'
        and exists (select 1 from public.spots s where s.id = ratings.spot_id and s.active)
    );
