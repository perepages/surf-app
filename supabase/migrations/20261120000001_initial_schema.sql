-- Initial schema for the self-learning surf forecast.
-- All times are timestamptz and are written in UTC.
-- Row-level security: everything is closed by default. The jobs use the service role key,
-- which bypasses RLS, so "only the jobs can write" needs no write policies at all.
-- The public (anon key) gets only the read/insert policies at the bottom of this file.

-- ---------------------------------------------------------------------------
-- spots: one row per surf spot. Adding a spot = inserting a row (config-driven).
-- ---------------------------------------------------------------------------
create table public.spots (
    id                  text primary key,                    -- slug, e.g. 'vilanova'
    name                text not null,
    lat                 double precision not null check (lat between -90 and 90),
    lon                 double precision not null check (lon between -180 and 180),
    beach_orientation   smallint not null check (beach_orientation between 0 and 359),
                                                             -- degrees the beach faces (0 = N, 90 = E)
    windy_cam_id        text,                                -- Windy Webcams API v3 id
    buoy_ids            text[] not null default '{}',        -- PORTUS buoy ids, nearest first
    water_polygon       jsonb,                               -- water area on the cam image:
                                                             -- [[x, y], ...], x/y from 0 to 1
    active              boolean not null default true,
    created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- forecasts: Open-Meteo forecast for each spot, one row per (fetch, valid hour).
-- ---------------------------------------------------------------------------
create table public.forecasts (
    id                              bigint generated always as identity primary key,
    spot_id                         text not null references public.spots (id),
    fetched_at                      timestamptz not null,
    valid_at                        timestamptz not null,
    lead_hours                      integer generated always as
                                        ((extract(epoch from (valid_at - fetched_at)) / 3600)::integer) stored,
    marine_model                    text,                    -- Open-Meteo model that produced the waves
    -- waves (combined sea state)
    wave_height                     real,                    -- m
    wave_period                     real,                    -- s
    wave_direction                  smallint,                -- degrees, where waves come from
    -- primary swell
    swell_wave_height               real,
    swell_wave_period               real,
    swell_wave_peak_period          real,
    swell_wave_direction            smallint,
    -- secondary swell
    secondary_swell_wave_height     real,
    secondary_swell_wave_period     real,
    secondary_swell_wave_direction  smallint,
    -- wind waves
    wind_wave_height                real,
    wind_wave_period                real,
    wind_wave_direction             smallint,
    -- wind (10 m)
    wind_speed                      real,                    -- km/h
    wind_direction                  smallint,                -- degrees, where wind comes from
    wind_gusts                      real,                    -- km/h
    -- tide
    sea_level_height                real,                    -- m relative to mean sea level
    unique (spot_id, fetched_at, valid_at)
);
create index forecasts_spot_valid_idx on public.forecasts (spot_id, valid_at desc);

-- ---------------------------------------------------------------------------
-- observations: PORTUS buoy readings. TRAINING ONLY - never readable by the public.
-- ---------------------------------------------------------------------------
create table public.observations (
    id                  bigint generated always as identity primary key,
    spot_id             text not null references public.spots (id),
    buoy_id             text not null,
    observed_at         timestamptz not null,
    wave_height         real,                                -- m (significant height)
    wave_period         real,                                -- s (peak period)
    wave_direction      smallint,                            -- degrees
    wind_speed          real,                                -- km/h
    wind_direction      smallint,                            -- degrees
    unique (spot_id, buoy_id, observed_at)
);
create index observations_spot_time_idx on public.observations (spot_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- snapshots: cam images (stored in the private 'snapshots' bucket) + crowd counts.
-- ---------------------------------------------------------------------------
create table public.snapshots (
    id                  bigint generated always as identity primary key,
    spot_id             text not null references public.spots (id),
    taken_at            timestamptz not null,
    image_path          text not null,                       -- path inside the 'snapshots' bucket
    crowd_water         smallint check (crowd_water >= 0),   -- people in the water polygon
    crowd_beach         smallint check (crowd_beach >= 0),   -- people outside it
    quality             text not null default 'ok'
                            check (quality in ('ok', 'dark', 'blurry', 'unusable')),
    unique (spot_id, taken_at)
);

-- ---------------------------------------------------------------------------
-- ratings: how it really was. Ground truth for training.
-- ---------------------------------------------------------------------------
create table public.ratings (
    id                  bigint generated always as identity primary key,
    spot_id             text not null references public.spots (id),
    surfed_at           timestamptz not null,
    overall             smallint not null check (overall between 1 and 5),
    wave_size           text check (wave_size in
                            ('flat', 'ankle', 'knee', 'waist', 'chest', 'head', 'overhead')),
    surface             text check (surface in ('glassy', 'clean', 'choppy', 'messy')),
    crowd               text check (crowd in ('empty', 'few', 'busy', 'packed')),
    comment             text check (char_length(comment) <= 500),
    source              text not null check (source in ('community', 'me', 'past_session')),
    device_id           text check (char_length(device_id) <= 64),  -- random id kept on the device
    near_beach          boolean,                             -- was the device near the spot
    forecast_shown      jsonb,                               -- exact forecast the user saw
    created_at          timestamptz not null default now()
);
create index ratings_spot_time_idx on public.ratings (spot_id, surfed_at desc);

-- ---------------------------------------------------------------------------
-- models: trained models per spot. At most one active model per spot.
-- ---------------------------------------------------------------------------
create table public.models (
    id                  bigint generated always as identity primary key,
    spot_id             text not null references public.spots (id),
    version             text not null,
    trained_at          timestamptz not null default now(),
    accuracy            real,                                -- score on recent held-out ratings
    artifact_path       text,                                -- model file in storage
    is_active           boolean not null default false,
    unique (spot_id, version)
);
create unique index models_one_active_per_spot on public.models (spot_id) where is_active;

-- ---------------------------------------------------------------------------
-- predictions: what the app shows. Latest prediction per (spot, hour), upserted by the jobs.
-- ---------------------------------------------------------------------------
create table public.predictions (
    id                  bigint generated always as identity primary key,
    spot_id             text not null references public.spots (id),
    valid_at            timestamptz not null,
    simple_score        smallint not null check (simple_score between 1 and 5),
    ai_score            real check (ai_score between 1 and 5),   -- null until a model exists
    ai_wave_height      real,                                -- m
    confidence          real check (confidence between 0 and 1),
    reason              text,                                -- short human-readable "why"
    model_version       text,                                -- null = simple score only
    updated_at          timestamptz not null default now(),
    unique (spot_id, valid_at)
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.spots        enable row level security;
alter table public.forecasts    enable row level security;
alter table public.observations enable row level security;
alter table public.snapshots    enable row level security;
alter table public.ratings      enable row level security;
alter table public.models       enable row level security;
alter table public.predictions  enable row level security;

-- Public read
create policy "public can read active spots"
    on public.spots for select to anon, authenticated
    using (active);

create policy "public can read forecasts"
    on public.forecasts for select to anon, authenticated
    using (true);

create policy "public can read predictions"
    on public.predictions for select to anon, authenticated
    using (true);

-- Public insert of community ratings only, for a recent session at an active spot.
-- 'me' and 'past_session' ratings are written by the jobs/CLI with the service key.
create policy "public can insert community ratings"
    on public.ratings for insert to anon, authenticated
    with check (
        source = 'community'
        and surfed_at between now() - interval '7 days' and now() + interval '1 hour'
        and exists (select 1 from public.spots s where s.id = spot_id and s.active)
    );

-- observations, snapshots, models: no policies = no public access at all.

-- ---------------------------------------------------------------------------
-- Storage: private bucket for cam snapshots (no policies = service key only).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('snapshots', 'snapshots', false)
on conflict (id) do nothing;
