-- Private bucket for trained model files (jobs/train.py): <spot>/<version>.joblib + .json.
-- No policies = only the service key can read or write it. Model files are pickles, so they
-- must never be writable by anyone else (loading one runs code).
insert into storage.buckets (id, name, public)
values ('models', 'models', false)
on conflict (id) do nothing;
