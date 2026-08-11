-- Migration: 0031_create_voting_candidates
-- Slice 007 — Voting Engine (Proving Case).
--
-- The Voting engine's own data for one interaction instance — a 1:N
-- extension keyed by interaction_instance_id, mirroring
-- multiple_choice_details' 1:1 extension-table shape (0024), widened
-- to N rows since a Voting round has multiple Candidates rather than
-- one engine-owned detail row.
--
-- This is Candidate Resolution's output, not its own mechanism: rows
-- here are always a Voting-owned, immutable snapshot, created once,
-- at interaction start, inside start_session_atomically (0033) —
-- regardless of whether the source was host-authored text or another,
-- already-completed Interaction Instance's submissions. Nothing here
-- records which source produced a given Candidate; that provenance
-- lives only in the INTERACTION_STARTED event's payload, since no read
-- path in this slice needs it back as structured, queryable data (see
-- that table's application-layer type comment for the promotion path
-- if that changes later).
--
-- ordinal is presentation order, snapshotted at creation exactly once
-- — never recomputed, mirroring prepared_questions' ordinal precedent
-- (0025) rather than interaction_instances' own deliberate avoidance
-- of a stored sequence number (0015): unlike interaction instances,
-- Candidates within one Voting round are not created one at a time in
-- presentation order, so a stored ordinal is required here too.
--
-- voting_candidates_instance_candidate_unique is a composite unique
-- constraint over (interaction_instance_id, candidate_id), alongside
-- (not instead of) the candidate_id primary key. Its sole purpose is
-- to serve as the target of votes' own composite foreign key (0032) —
-- without it, nothing in the schema itself prevents a vote from
-- referencing a Candidate that belongs to a *different* Voting
-- interaction instance than the vote's own interaction_instance_id;
-- cast_vote_atomically's explicit application-level check would be the
-- only thing enforcing that invariant. This is genuinely achievable in
-- Postgres via a composite FK, so it is enforced at the schema level
-- as well, not left to application code alone.

create table if not exists voting_candidates (
  candidate_id             uuid primary key default gen_random_uuid(),
  interaction_instance_id  uuid not null references interaction_instances(interaction_instance_id) on delete cascade,
  ordinal                  integer not null,
  label                    text not null,
  created_at               timestamptz not null default now(),

  constraint voting_candidates_label_not_empty check (btrim(label) <> ''),
  constraint voting_candidates_instance_candidate_unique unique (interaction_instance_id, candidate_id)
);

create unique index if not exists voting_candidates_interaction_ordinal_unique
  on voting_candidates (interaction_instance_id, ordinal);
