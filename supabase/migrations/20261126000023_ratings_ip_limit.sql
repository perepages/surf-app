-- Rating protection by IP address (scaling item 4), inside the database: no new server or
-- service. Adds to the per-device limit (3 a day, migration 6), which anyone can get around by
-- clearing site data (a new device id).
--
-- Which IP: `cf-connecting-ip`, written by Cloudflare in front of Supabase. Tested 2026-11-26:
-- a client that sends its own cf-connecting-ip is blocked (HTTP 403), while x-forwarded-for can
-- be faked (the client's value is kept in front), so only cf-connecting-ip is used. If it is
-- missing, the IP limit is skipped (the device limit still applies).
--
-- Limits for public ('community') ratings from one IP: IP_PER_HOUR in any rolling hour,
-- IP_PER_DAY in any rolling 24 h. Generous on purpose: phone networks put many people behind
-- one IP (carrier-grade NAT), and a surf class on one wifi rates together.
--
-- Privacy: the IP itself is never stored. rating_ip_log keeps sha256(secret salt + IP), cut to
-- 16 bytes, with the time, for 48 h (older rows are deleted by the trigger). Not linked to the
-- rating row. No public access to either table.
--
-- Also removes the temporary test function zz_ip_probe (created by hand for this test).
-- Safe to run again.

drop function if exists public.zz_ip_probe();

-- Secret salt, made once. Without it, a hash of an IP could be reversed by trying all IPs.
create table if not exists public.rating_ip_salt (
    id   boolean primary key default true check (id),
    salt text not null default encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex')
);
insert into public.rating_ip_salt (id) values (true) on conflict (id) do nothing;
alter table public.rating_ip_salt enable row level security;
revoke all on public.rating_ip_salt from public, anon, authenticated, service_role;

create table if not exists public.rating_ip_log (
    ip_hash    bytea       not null,
    created_at timestamptz not null default now()
);
create index if not exists rating_ip_log_hash_idx on public.rating_ip_log (ip_hash, created_at desc);
create index if not exists rating_ip_log_time_idx on public.rating_ip_log (created_at);
alter table public.rating_ip_log enable row level security;
revoke all on public.rating_ip_log from public, anon, authenticated;
grant select on public.rating_ip_log to service_role;  -- admin counts only

create or replace function public.ratings_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    ip_per_hour constant integer := 6;
    ip_per_day  constant integer := 15;
    recent    integer;
    day_count integer;
    ip        text;
    v_hash    bytea;
begin
    if new.source <> 'community' then
        return new;
    end if;

    -- 1. Per device (unchanged): 3 per rolling 24 h.
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

    -- 2. Per IP (Cloudflare's header; skipped when missing).
    ip := nullif(trim(current_setting('request.headers', true)::json ->> 'cf-connecting-ip'), '');
    if ip is not null then
        select substring(sha256(convert_to(s.salt || '|' || ip, 'UTF8')) from 1 for 16)
          into v_hash from public.rating_ip_salt s;
        perform pg_advisory_xact_lock(hashtextextended('ratings-ip:' || encode(v_hash, 'hex'), 0));
        select count(*) filter (where created_at > now() - interval '1 hour'),
               count(*)
          into recent, day_count
          from public.rating_ip_log l
         where l.ip_hash = v_hash
           and created_at > now() - interval '24 hours';
        if recent >= ip_per_hour then
            raise exception 'rate_limit_ip: max % ratings per network per hour', ip_per_hour
                using errcode = 'P0001', hint = 'Try again later.';
        end if;
        if day_count >= ip_per_day then
            raise exception 'rate_limit_ip: max % ratings per network per day', ip_per_day
                using errcode = 'P0001', hint = 'Try again tomorrow.';
        end if;
        insert into public.rating_ip_log (ip_hash) values (v_hash);
        -- Housekeeping: nothing older than 48 h is kept.
        delete from public.rating_ip_log where created_at < now() - interval '48 hours';
    end if;
    return new;
end;
$$;

revoke all on function public.ratings_rate_limit() from public, anon, authenticated;
-- The trigger from migration 6 already calls this function; nothing else to change.
