-- Migration: 0059_create_evaluations
-- Soccer Predictions — corrected model. Immutable settlement snapshot:
-- what the system concluded for one Prediction against one specific,
-- finalized Result Version, across exactly four independent
-- dimensions — Scoreline, Goalscorer, Goal Minute, First Team to
-- Score. There is no separate Outcome dimension and none of the four
-- columns here is a hidden fifth score-derived check; each is
-- evaluated entirely on its own terms.
--
-- UNIQUE(prediction_id, match_result_id) — one evaluation per pairing,
-- never updated after insert. A correction never mutates an old
-- evaluation; it produces a new row against the new match_result_id,
-- leaving every prior row exactly as computed.

create table evaluations (
  evaluation_id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null references predictions (prediction_id),
  match_result_id uuid not null references match_results (match_result_id),
  scoreline_correct boolean not null,
  goalscorer_correct boolean not null,
  goal_minute_correct boolean not null,
  first_team_to_score_correct boolean not null,
  correct_dimension_count integer not null,
  evaluated_at timestamptz not null default now(),
  unique (prediction_id, match_result_id)
);

alter table evaluations
  add constraint evaluations_dimension_count_range
  check (correct_dimension_count between 0 and 4);

create index evaluations_prediction_id_idx on evaluations (prediction_id);
create index evaluations_match_result_id_idx on evaluations (match_result_id);
