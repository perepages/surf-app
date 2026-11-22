-- Surf alerts by web push. Apply after migration 12. Safe to run again.
--
-- A phone that turns on an alert stores its push subscription here: the browser's push address
-- (`endpoint`, a long unguessable URL at Google/Apple/Mozilla/Microsoft) and its two public
-- encryption keys, plus the spot and the minimum score. No account, no device id, no location.
--
-- The public can't read or write the table. Three functions (SECURITY DEFINER) let the app
-- add/change, remove and list ITS OWN alerts; "own" = knowing the endpoint, which only that
-- browser has. The hourly job (jobs/notify.py, service key) reads the table, sends the pushes
-- and deletes subscriptions the push service says are gone.

create table if not exists public.push_subscriptions (
    id              bigint generated always as identity primary key,
    endpoint        text not null check (length(endpoint) between 20 and 1000),
    p256dh          text not null check (length(p256dh) between 40 and 200),
    auth            text not null check (length(auth) between 8 and 100),
    spot_id         text not null references public.spots (id) on delete cascade,
    min_score       smallint not null check (min_score between 2 and 5),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    last_sent_at    timestamptz,                -- last alert sent (at most one per 12 h)
    notified_until  timestamptz,                -- end of the good window already announced
    failures        smallint not null default 0, -- send errors in a row (dropped at 10)
    unique (endpoint, spot_id)
);

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions to service_role;

-- Only real push services: the job never sends to an address someone typed in.
create or replace function public.push_endpoint_ok(p_endpoint text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
    select p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
$$;

-- ---------------------------------------------------------------------------
-- Turn on (or change) the alert for one spot. Keys are refreshed on every row of this
-- endpoint (browsers can rotate them). Changing the minimum score forgets the last announced
-- window, so the new threshold can alert at once.
-- ---------------------------------------------------------------------------
create or replace function public.push_subscribe(
    p_endpoint text, p_p256dh text, p_auth text, p_spot_id text, p_min_score integer)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
    if p_endpoint is null or not public.push_endpoint_ok(p_endpoint) then
        raise exception 'not a supported push service' using errcode = '22023';
    end if;
    if p_min_score is null or p_min_score not between 2 and 5 then
        raise exception 'min score must be 2-5' using errcode = '22023';
    end if;
    if not exists (select 1 from spots where id = p_spot_id and active) then
        raise exception 'unknown spot' using errcode = '22023';
    end if;
    if (select count(*) from push_subscriptions
        where endpoint = p_endpoint and spot_id <> p_spot_id) >= 10 then
        raise exception 'at most 10 alerts per phone' using errcode = '22023';
    end if;

    update push_subscriptions
       set p256dh = p_p256dh, auth = p_auth, updated_at = now(), failures = 0
     where endpoint = p_endpoint;

    insert into push_subscriptions (endpoint, p256dh, auth, spot_id, min_score)
    values (p_endpoint, p_p256dh, p_auth, p_spot_id, p_min_score)
    on conflict (endpoint, spot_id) do update
        set min_score      = excluded.min_score,
            notified_until = case when push_subscriptions.min_score = excluded.min_score
                                  then push_subscriptions.notified_until end,
            updated_at     = now();
end;
$$;

-- Turn off one spot's alert, or all of this phone's alerts (p_spot_id null). Returns how many.
create or replace function public.push_unsubscribe(p_endpoint text, p_spot_id text default null)
returns integer
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
    with d as (
        delete from push_subscriptions
         where endpoint = p_endpoint and (p_spot_id is null or spot_id = p_spot_id)
        returning 1
    )
    select count(*)::integer from d;
$$;

-- This phone's alerts (so the app shows the truth, e.g. after the job dropped a dead one).
create or replace function public.push_alerts(p_endpoint text)
returns table (spot_id text, min_score smallint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select spot_id, min_score from push_subscriptions where endpoint = p_endpoint order by spot_id;
$$;

revoke all on function public.push_endpoint_ok(text) from public;
revoke all on function public.push_subscribe(text, text, text, text, integer) from public;
revoke all on function public.push_unsubscribe(text, text) from public;
revoke all on function public.push_alerts(text) from public;
grant execute on function public.push_subscribe(text, text, text, text, integer) to anon, authenticated;
grant execute on function public.push_unsubscribe(text, text) to anon, authenticated;
grant execute on function public.push_alerts(text) to anon, authenticated;
grant execute on function public.push_endpoint_ok(text) to service_role;
