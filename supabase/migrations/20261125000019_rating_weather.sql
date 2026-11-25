-- Ratings separate waves from weather (docs/surf_theory.md section 7.4).
--
-- spots.wind_station / spots.weather_station: Meteocat XEMA station codes (open data, no key)
--   used to attach the MEASURED weather to each rating. Wind from a station at the coast; rain,
--   temperature, humidity and sunshine from one that measures them (the Barcelona harbour
--   station Y7 has wind only, so the Barcelona spots take rain/temperature from X4 el Raval).
--   null = no measured weather for that spot.
-- ratings.weather_problem: the optional tap "Was the weather the problem?" in the rating form
--   (true = rain / cold / storm spoiled it; false = no; null = not answered). The public may set
--   it when inserting a rating.
-- ratings.weather_measured: written by `python -m jobs.rating_weather` (hourly job, service key
--   only; the public can never set or read it): what the stations measured around surfed_at.
-- Safe to run again.

alter table public.spots add column if not exists wind_station text;
alter table public.spots add column if not exists weather_station text;

alter table public.ratings add column if not exists weather_problem boolean;
alter table public.ratings add column if not exists weather_measured jsonb;

-- Insert-only column grant, like the other rating columns (migration 6). weather_measured gets
-- no public grant at all.
grant insert (weather_problem) on public.ratings to anon, authenticated;

update public.spots set wind_station = 'YR', weather_station = 'YR' where id in ('vilanova', 'sitges');
update public.spots set wind_station = 'XL', weather_station = 'XL' where id = 'castelldefels';
update public.spots set wind_station = 'Y7', weather_station = 'X4' where id in ('barceloneta', 'bogatell');
