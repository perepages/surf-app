-- All wave trains + weather in `forecasts` (docs/surf_theory.md sections 3 and 6).
--
-- Already existing columns that the hourly job now also fills (best_match = Météo-France
-- wave model at our spots): swell_wave_peak_period, secondary_swell_wave_*, wind_wave_period,
-- wind_wave_direction.
--
-- gfs_* = the full partition set of NOAA GFS-Wave 0.16° (`ncep_gfswave016`), the only model
-- with a TERTIARY swell. Stored as its own set, never mixed into the best_match columns: the two
-- models split the sea differently (the same swell can sit in a different slot), so mixing
-- would count some trains twice. GFS reports a missing train as 0.0 (height, period and
-- direction 0), not null.
--
-- Weather (Open-Meteo Forecast API, best_match): precipitation mm in the preceding hour,
-- precipitation_probability %, WMO weather_code (95/96/99 = thunderstorm), cape J/kg,
-- temperature_2m °C. sea_surface_temperature °C from the marine API.
-- Safe to run again.

alter table public.forecasts
  add column if not exists sea_surface_temperature        real,
  add column if not exists gfs_swell_wave_height           real,
  add column if not exists gfs_swell_wave_period           real,
  add column if not exists gfs_swell_wave_direction        smallint,
  add column if not exists gfs_secondary_swell_wave_height real,
  add column if not exists gfs_secondary_swell_wave_period real,
  add column if not exists gfs_secondary_swell_wave_direction smallint,
  add column if not exists gfs_tertiary_swell_wave_height  real,
  add column if not exists gfs_tertiary_swell_wave_period  real,
  add column if not exists gfs_tertiary_swell_wave_direction smallint,
  add column if not exists gfs_wind_wave_height            real,
  add column if not exists gfs_wind_wave_period            real,
  add column if not exists gfs_wind_wave_direction         smallint,
  add column if not exists precipitation                   real,
  add column if not exists precipitation_probability       smallint,
  add column if not exists weather_code                    smallint,
  add column if not exists cape                            real,
  add column if not exists temperature_2m                  real;
