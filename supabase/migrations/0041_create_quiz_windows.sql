-- Migration: 0041_create_quiz_windows
-- Quiz Experience (self-paced, independent participant progression —
-- distinct from Trivia, accepted after a dedicated implementation-
-- readiness pressure test).
--
-- A Quiz Window is the minimum authoritative state that genuinely
-- cannot be derived from anything else already in the schema: the
-- deadline, and whether the Quiz has been finalized. Deliberately
-- minimal — pressure-tested against a four-column proposal
-- (opens_at, closes_at, closed_at, closed_by) and trimmed to two:
--
-- - opens_at was dropped. A Quiz opens exactly when its Segment (and
--   therefore this row) is created — segments.created_at (already
--   exists, 0035) already is that fact. Storing it again here would be
--   a pure duplicate, not new information.
-- - closed_by was dropped. It is audit information, not an
--   authoritative fact anything downstream needs to branch on — it can
--   be added later as a plain additive column, with zero migration
--   risk, if it ever becomes load-bearing.
--
-- Why closed_at must exist as its own persisted fact, separate from
-- every Quiz question's own Interaction Instance state: closing is not
-- instantaneous with the deadline. Something (a host click, or any
-- client's poll noticing the deadline has passed) must trigger
-- close_quiz_atomically before the N Interaction Instances actually
-- transition to RESULT_REVEAL. In the gap between "closes_at has
-- passed" and "close_quiz_atomically has actually run," every question
-- instance still legitimately says PROMPT_ACTIVE — so late-submission
-- rejection cannot be derived from instance state alone and needs its
-- own authoritative check. See submit_quiz_response_atomically
-- (0043)'s WHERE clause.
--
-- One row per Quiz Segment — segment_id is both primary key and the
-- foreign key, since a Quiz Window has no independent identity or
-- lifetime apart from the Segment it belongs to. ON DELETE CASCADE
-- mirrors every other child-of-Segment/child-of-Session table in this
-- schema (segments itself cascades from sessions; interaction_instances
-- was not given its own explicit ON DELETE on segment_id, but this
-- table follows the same "delete the child when the parent goes"
-- convention established by prepared_questions -> sessions,
-- multiple_choice_details -> interaction_instances, etc.).
--
-- No lifecycle/state column, matching segments' own precedent (0035):
-- "open" vs "closed" is entirely derivable from closed_at IS NULL,
-- never a separately stored flag that could drift from the truth.
--
-- This is additive only: no existing table is altered by this
-- migration.

create table if not exists quiz_windows (
  segment_id  uuid primary key references segments(segment_id) on delete cascade,
  closes_at   timestamptz not null,
  closed_at   timestamptz
);
