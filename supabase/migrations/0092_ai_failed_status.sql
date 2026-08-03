-- A failed analysis must be VISIBLE.
--
-- Three samples submitted on 2026-08-03 sat at "submitted" indefinitely. The
-- analysis had run and died, but nothing recorded that: the status enum has no
-- failure value, so a sample whose analysis crashed is indistinguishable from
-- one whose analysis was never triggered, one skipped by the daily cap, and one
-- still queued. The collector sees "Submitted" forever and has no way to tell
-- that anything is wrong, let alone what.
--
-- This does not fix whatever the analysis choked on. It makes the choking
-- observable and recoverable, which is the prerequisite for fixing it — and for
-- a geologist standing in the field, "this failed, try again" is a usable
-- answer where silence is not.
--
-- The enum value is added HERE, alone. Postgres allows ALTER TYPE ADD VALUE
-- inside a transaction but forbids USING the new value in that same
-- transaction, so the RPCs that reference it live in the next migration.

alter type enterprise.sample_status add value if not exists 'ai_failed';

-- Why it failed and when it was last attempted. Both on the sample rather than
-- in a side table: the collector's screen already reads the sample, and a
-- failure the UI cannot reach is the problem being fixed, not a new place to
-- hide it.
alter table enterprise.sample
  add column if not exists ai_error text,
  add column if not exists ai_attempted_at timestamptz;

comment on column enterprise.sample.ai_error is
  'Why the last analysis attempt failed, in plain text. Null when the last attempt succeeded or none has run.';
comment on column enterprise.sample.ai_attempted_at is
  'When analysis was last STARTED — not when it finished. A row with this set and status still ai_processing is a run that died mid-flight.';
