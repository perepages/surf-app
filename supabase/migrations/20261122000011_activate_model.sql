-- Switch a spot's active model in ONE transaction (called by jobs/train.py with the service key).
-- Two separate updates from the job could leave a spot with no active model if the second
-- failed; inside a function both happen or neither does. The partial unique index
-- models_one_active_per_spot still guarantees at most one active model per spot.
create or replace function public.activate_model(p_model_id bigint)
returns void
language plpgsql
set search_path = ''
as $$
declare
    v_spot text;
begin
    select spot_id into v_spot from public.models where id = p_model_id;
    if v_spot is null then
        raise exception 'model % not found', p_model_id using errcode = 'P0002';
    end if;
    -- Lock the spot's models so two runs can't switch at the same time.
    perform 1 from public.models where spot_id = v_spot for update;
    update public.models set is_active = false
        where spot_id = v_spot and is_active and id <> p_model_id;
    update public.models set is_active = true where id = p_model_id;
end;
$$;

-- Service key only: the public must never be able to switch models.
revoke all on function public.activate_model(bigint) from public, anon, authenticated;
grant execute on function public.activate_model(bigint) to service_role;
