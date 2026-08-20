-- Migration: 0055_create_prize_tiers
-- Soccer Predictions. Venue Activation-specific physical prize tiers,
-- keyed by correctDimensionCount (still 0-4: the corrected model
-- evaluates exactly four independent dimensions — Scoreline,
-- Goalscorer, Goal Minute, First Team to Score). Deliberately sparse:
-- no row for a given count is itself the valid "no physical prize"
-- state — 2/4 is not seeded with a guessed value.

create table prize_tiers (
  prize_tier_id uuid primary key default gen_random_uuid(),
  venue_activation_id uuid not null references venue_activations (venue_activation_id),
  correct_dimension_count integer not null,
  prize_label text not null,
  created_at timestamptz not null default now(),
  unique (venue_activation_id, correct_dimension_count)
);

alter table prize_tiers
  add constraint prize_tiers_dimension_count_range check (correct_dimension_count between 1 and 4);
alter table prize_tiers
  add constraint prize_tiers_label_not_empty check (char_length(btrim(prize_label)) >= 1);

create index prize_tiers_venue_activation_id_idx on prize_tiers (venue_activation_id);
