-- Predictions from the physics engine (docs/surf_theory.md section 7).
--
--   physics_waves / physics_shape / physics_overall  the rule-based scores (jobs/physics.py),
--                                                    written every hour for every predicted hour
--   ai_waves / ai_shape                              the active model's corrected Waves and Shape
--   ai_score                                         now = overall(ai_waves, ai_shape): the wave
--                                                    quality WITHOUT comfort. Rain, cold and
--                                                    safety stay rule-based and are applied in the
--                                                    app with each user's preferences.
--   simple_score                                     the old simple score, kept until the app has
--                                                    moved to the physics score (then unused)
-- All 1-5 (floats; the app rounds half up). Safe to run again.

alter table public.predictions
  add column if not exists physics_waves   real check (physics_waves between 1 and 5),
  add column if not exists physics_shape   real check (physics_shape between 1 and 5),
  add column if not exists physics_overall real check (physics_overall between 1 and 5),
  add column if not exists ai_waves        real check (ai_waves between 1 and 5),
  add column if not exists ai_shape        real check (ai_shape between 1 and 5);
