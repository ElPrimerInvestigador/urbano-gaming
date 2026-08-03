-- Migration: 0021_create_point_awards
-- Slice 002 — Scored Multi-Round Experience.
--
-- A Point Award is one independent scoring event: the host awarding a
-- specific participant a positive number of points for a specific,
-- currently-revealed Interaction Instance. This is the ledger backing
-- Shared Game State for this slice — cumulative score is always
-- derived by summing these rows, never stored as a running total.
--
-- Deliberately minimal, per the accepted Slice 002 design:
-- - no uniqueness constraint on (interaction_instance_id, participant_id).
--   An interaction may legitimately produce more than one independent
--   scoring event for the same participant in a future experience —
--   that is an Experience-level rule, not something this generic
--   ledger should encode. Baking in "one award per participant per
--   interaction" here would quietly turn this table into a disguised
--   mutable per-interaction total rather than a true ledger of events.
-- - no updated_at, no update-in-place. Every row is permanent from the
--   moment it is written. Score correction is explicitly deferred for
--   this slice (see the accepted design) rather than solved via
--   upsert/last-write-wins the way submissions are — inventing a
--   correction mechanism before one is required would be exactly the
--   kind of premature generality this project's discipline avoids.
-- - points is positive-only (check > 0). The only reason a negative
--   value would exist is to support correction, which is deferred;
--   revisit this constraint with evidence if a future slice needs
--   penalties or corrections.
-- - idempotency_key is scoped to the session, not globally unique
--   (unique (session_id, idempotency_key)) — the key represents one
--   logical award command within a Session, and global uniqueness
--   would create an avoidable cross-Session collision case with no
--   compensating benefit. It exists solely to make a retried or raced
--   network request return the original result rather than error or
--   duplicate; it deliberately does NOT protect against two distinct
--   host actions producing two distinct awards for the same
--   participant and interaction, since the accepted ledger model
--   permits exactly that.
--
-- This is additive only: no existing table is altered by this
-- migration.

create table if not exists point_awards (
  point_award_id           uuid primary key default gen_random_uuid(),
  session_id               uuid not null references sessions(session_id) on delete cascade,
  interaction_instance_id  uuid not null references interaction_instances(interaction_instance_id),
  participant_id           uuid not null references participants(participant_id),
  points                   integer not null,
  idempotency_key          uuid not null,
  created_at               timestamptz not null default now(),

  constraint point_awards_points_positive check (points > 0),
  constraint point_awards_session_idempotency_key_unique unique (session_id, idempotency_key)
);

-- Supports the standings derivation query: sum points grouped by
-- participant, scoped to one session.
create index if not exists point_awards_session_participant_idx
  on point_awards (session_id, participant_id);
