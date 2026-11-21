-- Ratings record which app version sent them, so a UI or scoring change can be told apart
-- in training. Apply after migration 4. Safe to run again: re-running it after migration 4
-- restores the grant below (migration 4's table-level REVOKE also removes column grants).

alter table public.ratings
    add column if not exists app_version text check (char_length(app_version) <= 32);

-- Migration 4 switched the public to column-level insert grants, so the new column needs its own.
grant insert (app_version) on public.ratings to anon, authenticated;
