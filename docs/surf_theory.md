# surfcast — Surf theory & prediction rules

This file is the physics and surf knowledge behind surfcast's predictions.
The rule-based "physics score" uses it directly. The AI model uses it as
features and learns per-spot corrections on top. Every number below is a
starting value to tune per spot, not a law.

---

## 1. Three separate scores (never mix them)

| Score | Question it answers | Main inputs |
|---|---|---|
| **Waves** | Is there enough surfable energy reaching this beach? | swell height, period, direction vs spot window |
| **Shape** | Are the waves clean or messy? | wind vs beach orientation, crossed swells, wind sea |
| **Comfort** | Do I want to be there? | rain, thunderstorms, air/water temp, daylight |

Plus **Safety flags** that can override everything (thunderstorm, too big for
the user's level, strong currents, bad water quality after heavy rain).

Overall = f(Waves, Shape), then Comfort adjusts it according to the
user's preferences (e.g. "I don't mind rain"). Safety flags force "SKIP" or
show a warning.

Why separate: a day with great waves and heavy rain is a *good wave day*
but a *bad day to go*. If both are mixed into one label, the AI learns
nonsense ("rain makes waves worse").

---

## 2. Swell physics

### Energy: height and period
- Wave power (deep water), in kW per metre of wave front:
  `P ≈ 0.49 · H² · T` (H = significant height in m, T = period in s).
- Period matters as much as height: 1.0 m at 9 s carries ~1.8× the
  energy of 1.0 m at 5 s.
- Deep-water wavelength: `L ≈ 1.56 · T²` m. Longer period waves feel the
  bottom earlier, refract more and grow more when they break.

### Breaking wave height (what the surfer sees)
Komar & Gaughan (1972) estimate of breaker height:

`Hb ≈ 0.39 · g^0.2 · (T · H0²)^0.4` (g = 9.81, H0 = deep-water height)

Use it as a feature ("estimated breaking height"), then let the model
correct it per spot. Short-period wind swell (T < 6 s) usually breaks
smaller and weaker than the offshore height suggests.

### Swell window (direction)
- Each spot has a **beach normal** (the compass direction the beach faces,
  towards the sea) and a **swell window** (min/max directions that can reach
  it without being blocked by capes, ports or breakwaters). Store both per
  spot.
- Angle `θ` = difference between swell direction (where it comes FROM) and
  the beach normal. Energy reaching the beach ≈ `cos(θ)` (≈0 at 90°+).
- Swell outside the window → treat as almost no waves, whatever the height.

### Mediterranean specifics (Catalan coast)
- Short fetch → typical periods 4–9 s. A 7–8 s swell is "good" here; 10 s+
  is rare and special.
- Waves are often created by the same wind that ruins them (onshore
  Llevant/E-NE or Garbí/SW). The best sessions are often **when the wind
  drops or turns offshore while the swell is still there** ("the morning
  after"). Use wind history as a feature: wind direction/speed over the
  last 6, 12 and 24 h, not just now.
- Swell decays fast after the wind stops (hours, not days).

---

## 3. Multiple wave trains (the "good" waves vs the "other" waves)

Forecasts split the sea into partitions:
- **Primary swell**: the main, more organised waves (usually the good ones).
- **Secondary / tertiary swell**: other swells from different directions.
- **Wind waves (wind sea)**: short, choppy waves made by local wind.

Open-Meteo variables: `swell_wave_*`, `secondary_swell_wave_*`,
`tertiary_swell_wave_*` (tertiary only in GFS models; secondary only in some
models), `wind_wave_*`.

### How the extra wave trains hurt the good ones
They don't make the main swell disappear, but they break up its shape:
- Crossed swells (different directions) → peaky, shifty, close-out sets,
  less defined lines.
- Waves running against the main swell (opposite direction, ~150–210° apart)
  → choppy, bumpy faces, sets look smaller and break unpredictably.
- Strong wind sea on top → surface texture, "washing machine".

### Features to compute
- `primary_energy = H_swell² · T_swell`
- `other_energy = Σ (H² · T)` of secondary, tertiary and wind waves
- **Cleanliness ratio** `= primary_energy / (primary_energy + other_energy)`
  - > 0.75 → clean lines
  - 0.5–0.75 → some mess
  - < 0.5 → messy / mixed-up sea
- **Conflict angle** for each other train: angle between its direction and
  the primary direction.
  - < 30° → same family, mostly adds size
  - 30–120° → crossed sea, reduces shape
  - > 120° → opposing, reduces shape strongly
- **Conflict penalty** = Σ (other_energy_i / primary_energy) · weight(angle_i),
  with weight ≈ 0 (<30°), 0.5 (30–120°), 1.0 (>120°).

Shape score drops with the conflict penalty. The AI learns how much each
spot actually suffers from it.

---

## 4. Wind

Compute wind relative to the beach:
`rel = wind_from_direction − beach_normal` (normalise to −180..180).

- |rel| ≈ 180° → **offshore** (blows from land to sea): holds waves up, clean.
- |rel| ≈ 0° → **onshore** (blows from sea to land): crumbly, messy.
- |rel| ≈ 90° → **cross-shore**: in between, often bumpy.

Starting thresholds (km/h, sustained; tune per spot):

| Wind | Offshore | Cross-shore | Onshore |
|---|---|---|---|
| < 5 (glassy) | Excellent | Excellent | Very good |
| 5–12 | Excellent | Good | OK |
| 12–20 | Good | Bumpy | Poor |
| 20–30 | Hard to paddle, spray | Poor | Blown out |
| > 30 | Too strong | Blown out | Blown out |

Also use gusts: gusts > 1.6× mean wind = unstable, choppier.

---

## 5. Tide, sea level and currents

- The Mediterranean is micro-tidal (tide range ~20–30 cm). Tide rarely
  decides a session on its own, but some beach/reef breaks change with
  it. Use `sea_level_height_msl` (includes tide + pressure effect) and let
  the model learn per-spot sensitivity.
- Low pressure systems raise sea level (inverted barometer:
  ~1 cm per hPa below 1013). During storms this can matter more than tide.
- Currents (`ocean_current_velocity/direction`) are ~8 km resolution and
  not reliable at the shore. Use them only as a soft feature and for a
  generic "strong current" warning, never as a precise prediction.
- Rip currents get stronger with bigger, more frontal swell. Show a
  safety note when breaking height is high and swell is frontal (θ < 20°).

---

## 6. Weather, comfort and safety

Data: Open-Meteo Forecast API → `precipitation`, `precipitation_probability`,
`weather_code`, `cape`, `temperature_2m`, `cloud_cover`,
`sea_surface_temperature` (marine API), sunrise/sunset.

### Comfort score
- Rain: probability > 60 % and > 1 mm/h → strong penalty; drizzle → small
  penalty; dry → none.
- Cold: air < 10 °C or water < 14 °C → small penalty + wetsuit tip
  (e.g. water 13–15 °C → 4/3 mm; 16–19 °C → 3/2 mm; 20+ → shorty/none).
- Daylight: hours before sunrise / after sunset are never recommended.

### Safety flags (override)
- **Thunderstorm**: `weather_code` 95, 96, 99, or high CAPE with rain →
  "SKIP — lightning risk". Never recommend surfing in a thunderstorm.
- **Water quality after heavy rain**: > ~20 mm in the last 24 h near river
  mouths, storm drains or urban beaches → warning for 48–72 h (runoff can
  pollute the water). Use official bathing-water data when available.
- **Too big for level**: breaking height above the user's limit → warning.

### User preferences
Let each user set: "I don't mind rain", level (beginner / intermediate /
advanced), board type, max wave size. The same forecast gives different
recommendations to different people.

---

## 7. How the physics and the AI work together

1. **Physics score** (this file, rule-based) → Waves, Shape, Comfort,
   Safety, plus a plain-language reason ("Clean 0.8 m at 8 s, light
   offshore, but 70 % chance of rain").
2. **Features** for the AI = all raw inputs + every derived value above
   (energy, breaking height, swell-window angle, cleanliness ratio,
   conflict penalty, relative wind, wind history, sea level, rain).
3. **AI model** learns the *correction* between the physics score and
   reality (ratings, buoy, cam crowd), per spot. It predicts Waves and
   Shape separately; Comfort and Safety stay rule-based.
4. **Ratings must separate waves from weather**: store the measured
   weather at the time of each rating, and add an optional tap in the
   rating flow: "Was the weather the problem?" so a rainy day with good
   waves isn't learned as bad waves.
5. Show the user the overall verdict and *why*, including which wave
   trains are messing things up ("Secondary swell from the SW is crossing
   the main E swell → peaky and inconsistent").
