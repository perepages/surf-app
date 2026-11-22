-- Water area of each spot's cam image: where surfers in the water can be (for crowd_water).
-- Drawn with `python -m jobs.cam_area --spot <id>` (opens the cam image, click the outline).
--
-- spots.cam_water_area = {
--   "cam_id":   "<windy cam id it was drawn on>",   -- ignored if spots.windy_cam_id changes
--   "points":   [[x, y], ...],                       -- 3-40 points, 0..1 of image width/height,
--                                                      origin top-left (size-independent)
--   "image":    [400, 224],                          -- size of the image it was drawn on
--   "drawn_at": "2026-11-22"
-- }
-- null = no area drawn (the counting step then leaves crowd_water empty).
-- spots is publicly readable, so the app could show the area; it holds nothing private.

alter table public.spots add column if not exists cam_water_area jsonb;

create or replace function public.valid_cam_area(a jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select a is null or (
    jsonb_typeof(a) = 'object'
    and jsonb_typeof(a -> 'cam_id') = 'string'
    and jsonb_typeof(a -> 'points') = 'array'
    and jsonb_array_length(a -> 'points') between 3 and 40
    and not exists (
      select 1 from jsonb_array_elements(a -> 'points') p
      where case
        when jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 2 then true
        when jsonb_typeof(p -> 0) <> 'number' or jsonb_typeof(p -> 1) <> 'number' then true
        else (p ->> 0)::numeric not between 0 and 1 or (p ->> 1)::numeric not between 0 and 1
      end)
  )
$$;

alter table public.spots drop constraint if exists spots_cam_water_area_valid;
alter table public.spots add constraint spots_cam_water_area_valid
  check (public.valid_cam_area(cam_water_area));

-- Areas drawn 2026-11-22 on Windy's daylight preview (400x224). Rows that don't exist yet
-- are simply not updated; safe to run again.
update public.spots set cam_water_area = '{"cam_id": "1793884698", "image": [400, 224], "drawn_at": "2026-11-22",
  "points": [[0,0.47],[0.3,0.48],[0.5,0.51],[0.7,0.55],[0.85,0.57],[1,0.6],[1,1],[0,1]]}'
  where id = 'vilanova';
update public.spots set cam_water_area = '{"cam_id": "1701435626", "image": [400, 224], "drawn_at": "2026-11-22",
  "points": [[0.11,0.38],[1,0.37],[1,0.95],[0.78,0.92],[0.71,0.86],[0.8,0.66],[0.77,0.64],[0.66,0.76],[0.6,0.79],[0.5,0.77],[0.4,0.73],[0.31,0.7],[0.23,0.66],[0.16,0.6],[0.12,0.53],[0.11,0.47]]}'
  where id = 'sitges';
update public.spots set cam_water_area = '{"cam_id": "1450823411", "image": [400, 224], "drawn_at": "2026-11-22",
  "points": [[0,0.585],[0.19,0.595],[0.17,0.63],[0.13,0.7],[0.1,0.78],[0.06,0.84],[0,0.88]]}'
  where id = 'barceloneta';
