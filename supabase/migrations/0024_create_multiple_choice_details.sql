-- Migration: 0024_create_multiple_choice_details
-- Slice 003 — Second Interaction Engine (Multiple Choice Trivia).
--
-- The Multiple Choice engine's own data, attached to the generic
-- Interaction Instance rather than merged into it — this is the actual
-- test of whether "Interaction Engine" generalizes as a pattern.
-- interaction_instances itself gains no columns beyond engine_type
-- (0023); everything specific to this one engine lives here instead,
-- as a 1:1 extension keyed by interaction_instance_id.
--
-- correct_option_index is stored from the moment the row is created,
-- not only at reveal — it is genuinely private state (see
-- Architecture/State_Architecture.md's "Private State" category), the
-- first this platform has needed. GET_SESSION is exclusively
-- responsible for withholding it from participants until
-- RESULT_REVEAL; this table itself has no visibility logic — the same
-- division of responsibility already used for submissions.
--
-- points_for_correct is a per-question value, standing in for what
-- will eventually be an Experience Template's scoring rule — the same
-- kind of explicitly tracked simplification Slice 002 already made for
-- Shared Game State (see History/Slices/Slice_002/03_Slice_Design.md).

create table if not exists multiple_choice_details (
  interaction_instance_id uuid primary key references interaction_instances(interaction_instance_id) on delete cascade,
  options                  jsonb not null,
  correct_option_index     integer not null,
  points_for_correct       integer not null,
  created_at               timestamptz not null default now(),

  constraint multiple_choice_details_options_shape check (
    jsonb_typeof(options) = 'array' and jsonb_array_length(options) >= 2
  ),
  constraint multiple_choice_details_correct_option_index_bounds check (
    correct_option_index >= 0 and correct_option_index < jsonb_array_length(options)
  ),
  constraint multiple_choice_details_points_for_correct_bounds check (
    points_for_correct > 0 and points_for_correct <= 10000
  )
);
