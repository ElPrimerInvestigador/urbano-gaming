-- Migration: 0032_create_votes
-- Slice 007 — Voting Engine (Proving Case).
--
-- One participant's current vote in one Voting interaction instance.
-- Deliberately a new table, not a reuse of `submissions` the way
-- Multiple Choice reuses it for selected-option storage (0017's
-- comment). That reuse was justified specifically because MC's
-- selection is structurally identical to what submissions already
-- stored (a small ordinal, referenced by position, in a free-text
-- column). A vote instead references a real Candidate row — a genuine
-- foreign key voting_candidates(candidate_id) gives referential
-- integrity submissions.text (a bare string) cannot, and the
-- committed Gameplay Outcome Taxonomy (433b61e) already establishes
-- that a cast vote is conceptually distinct from a submission
-- (relational, engine-owned evidence; not a standalone, meaning-
-- bearing artifact) — reusing the same table would blur a distinction
-- that document deliberately draws. This divergence from the
-- submissions-reuse precedent is intentional, not an oversight.
--
-- votes_interaction_instance_participant_unique mirrors
-- submissions_interaction_instance_participant_unique (0016) exactly:
-- one vote per participant per interaction instance, upserted against
-- this constraint by cast_vote_atomically (0034) — "last write wins"
-- while the interaction remains PROMPT_ACTIVE, immutable once it is
-- not, via the same state guard every other write command in this
-- repository already uses.
--
-- candidate_id is NOT a bare `references voting_candidates(candidate_id)`
-- — it is a composite foreign key against
-- voting_candidates_instance_candidate_unique (0031):
-- (interaction_instance_id, candidate_id) together must match an
-- existing Candidate row's own (interaction_instance_id, candidate_id)
-- pair. A bare single-column FK would only guarantee the candidate_id
-- exists *somewhere*, not that it belongs to *this* vote's own
-- interaction instance — this composite form makes "a vote cannot
-- reference a Candidate from a different Voting interaction instance"
-- a schema-enforced invariant, not merely an application-level check
-- (cast_vote_atomically's own explicit ownership check remains, for a
-- clean domain error instead of a raw FK-violation, but is no longer
-- the only thing enforcing this).

create table if not exists votes (
  vote_id                  uuid primary key default gen_random_uuid(),
  interaction_instance_id  uuid not null references interaction_instances(interaction_instance_id) on delete cascade,
  participant_id           uuid not null references participants(participant_id) on delete cascade,
  candidate_id             uuid not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint votes_candidate_belongs_to_interaction
    foreign key (interaction_instance_id, candidate_id)
    references voting_candidates (interaction_instance_id, candidate_id)
    on delete cascade
);

create unique index if not exists votes_interaction_instance_participant_unique
  on votes (interaction_instance_id, participant_id);
