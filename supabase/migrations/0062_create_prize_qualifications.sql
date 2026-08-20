-- Migration: 0062_create_prize_qualifications
-- Soccer Predictions. Materialized only for genuine winners — a row
-- exists exactly when an evaluation's correctDimensionCount matched a
-- configured prize_tiers row for that Venue Activation.
-- UNIQUE(evaluation_id): each evaluation snapshot can produce at most
-- one qualification.
--
-- superseded_at: set (never a delete, never touching redeemed_at) when
-- a correction produces a new evaluation for the same Prediction that
-- no longer supports this tier. redeemed_at / redeemed_by_gaming_member_id:
-- v1 redemption is a single admin action, exactly once — never erased
-- by a later correction.

create table prize_qualifications (
  prize_qualification_id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references evaluations (evaluation_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  venue_activation_id uuid not null references venue_activations (venue_activation_id),
  prize_tier_id uuid not null references prize_tiers (prize_tier_id),
  redeemed_at timestamptz null,
  redeemed_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  superseded_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (evaluation_id)
);

create index prize_qualifications_gaming_member_id_idx on prize_qualifications (gaming_member_id);
create index prize_qualifications_venue_activation_id_idx on prize_qualifications (venue_activation_id);
