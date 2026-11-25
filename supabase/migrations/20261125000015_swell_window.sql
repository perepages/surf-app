-- Per-spot swell window (docs/surf_theory.md section 2).
--
-- spots.beach_orientation = the BEACH NORMAL: compass direction the beach faces, towards the
--   sea (kept under its old name: the app and jobs already read it).
-- spots.swell_window_min / swell_window_max = directions (degrees a swell comes FROM) that can
--   reach the beach without being blocked by capes, ports or breakwaters, read clockwise from
--   min to max. min > max means the window crosses north (e.g. 300 -> 40). Both null = unknown
--   (the physics score then uses beach_orientation +- 90).
-- Values below were measured 2026-11-25 by casting rays from each spot over the OpenStreetMap
-- coastline + harbour walls (same method as `python jobs/add_spot.py`), confirmed by me.
-- Safe to run again.

alter table public.spots add column if not exists swell_window_min smallint;
alter table public.spots add column if not exists swell_window_max smallint;

alter table public.spots drop constraint if exists spots_swell_window_valid;
alter table public.spots add constraint spots_swell_window_valid check (
  (swell_window_min is null and swell_window_max is null)
  or (swell_window_min between 0 and 359 and swell_window_max between 0 and 359
      and swell_window_min <> swell_window_max)
);

comment on column public.spots.beach_orientation is
  'Beach normal: compass direction the beach faces, towards the sea (degrees).';
comment on column public.spots.swell_window_min is
  'Swell window start, clockwise to swell_window_max (degrees swell comes from).';

update public.spots set beach_orientation = 165, swell_window_min = 105, swell_window_max = 240
  where id = 'vilanova';
update public.spots set beach_orientation = 170, swell_window_min = 100, swell_window_max = 240
  where id = 'sitges';
update public.spots set beach_orientation = 180, swell_window_min = 90,  swell_window_max = 250
  where id = 'castelldefels';
update public.spots set beach_orientation = 135, swell_window_min = 55,  swell_window_max = 190
  where id = 'barceloneta';
update public.spots set beach_orientation = 135, swell_window_min = 55,  swell_window_max = 200
  where id = 'bogatell';
