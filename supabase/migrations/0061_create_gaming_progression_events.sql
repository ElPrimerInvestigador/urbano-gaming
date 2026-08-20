-- Migration: 0061_create_gaming_progression_events
-- Soccer Predictions. Persistent Gaming Member progression ledger —
-- point_awards (Session-scoped) is not reused; this is its own,
-- separate, append-only ledger. A wrong award is neutralized by
-- inserting a compensating negative-points row
-- (reverses_gaming_progression_event_id pointing at the original),
-- never by editing or removing the original.
--
-- idempotency_key (text, human-readable, deterministic) +
-- UNIQUE(gaming_member_id, idempotency_key): the same idempotency-
-- first discipline as point_awards' own idempotency_key — e.g.
-- '<evaluation_id>:PREDICTION_PARTICIPATED' for an original award,
-- 'reverse:<original_event_id>' for a compensation.

create table gaming_progression_events (
  gaming_progression_event_id uuid primary key default gen_random_uuid(),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  rule_key text not null references progression_rule_points (rule_key),
  points integer not null,
  match_id uuid null references matches (match_id),
  evaluation_id uuid null references evaluations (evaluation_id),
  reverses_gaming_progression_event_id uuid null references gaming_progression_events (gaming_progression_event_id),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (gaming_member_id, idempotency_key)
);

create index gaming_progression_events_gaming_member_id_idx on gaming_progression_events (gaming_member_id);
create index gaming_progression_events_evaluation_id_idx on gaming_progression_events (evaluation_id);
create index gaming_progression_events_match_id_idx on gaming_progression_events (match_id);
