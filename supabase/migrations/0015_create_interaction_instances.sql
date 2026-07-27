-- Migration: 0015_create_interaction_instances
-- Slice 001 — Session / Interaction separation.
--
-- An Interaction Instance is one executable Open Response interaction
-- inside a Session. Sessions may now run zero, one, or many sequential
-- interaction instances; each owns its own prompt and its own
-- PROMPT_ACTIVE / SUBMISSIONS_CLOSED / RESULT_REVEAL lifecycle,
-- independent of the session's own (now narrower) lifecycle.
--
-- Deliberately minimal, per the accepted Slice 001 design:
-- - no sequence_number column — interactions are strictly sequential
--   and never concurrent, so ordering is fully recoverable from
--   created_at; a stored ordinal would be redundant.
-- - no state_version column — unlike sessions.state_version (already
--   validated, already depended upon, out of scope to touch), a
--   version counter on this brand-new table has no such history to
--   preserve and no current consumer. The actual concurrency guard is
--   the same row-lock pattern (SELECT ... FOR UPDATE) already used
--   throughout this repository, not a version counter.
-- - no stored "current interaction" pointer on sessions — "current"
--   is unambiguously "the most recently created interaction instance
--   for this session," resolved by query wherever needed.
--
-- This is additive only: no existing table is altered by this
-- migration (see 0016 for the one additive change to submissions).

create table if not exists interaction_instances (
  interaction_instance_id uuid primary key default gen_random_uuid(),
  session_id               uuid not null references sessions(session_id) on delete cascade,
  prompt_id                uuid not null references prompts(prompt_id),
  state                    text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint interaction_instances_state_valid_values check (
    state in ('PROMPT_ACTIVE', 'SUBMISSIONS_CLOSED', 'RESULT_REVEAL')
  )
);

-- Composite index supports the one query pattern every function in
-- this slice needs: "the most recently created interaction instance
-- for this session."
create index if not exists interaction_instances_session_created_idx
  on interaction_instances (session_id, created_at desc);
