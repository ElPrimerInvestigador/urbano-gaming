-- Migration: 0060_create_progression_rule_points
-- Soccer Predictions. Gaming progression point values, kept as data
-- rather than application constants so the founder can set real
-- values later without a code deploy — seeded at 0 for every required
-- key, a genuine "not yet decided" placeholder, not a guess. The
-- corrected four-dimension model still evaluates 0-4 dimensions, so
-- these five keys remain structurally valid unchanged.
--
-- Seeding PREDICTION_PARTICIPATED at 0 alongside the four performance
-- tiers also makes "participation stacks with performance" vs.
-- "performance replaces participation" a pure matter of these values
-- rather than a hardcoded policy.

create table progression_rule_points (
  rule_key text primary key,
  points integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into progression_rule_points (rule_key, points) values
  ('PREDICTION_PARTICIPATED', 0),
  ('PREDICTION_1_OF_4', 0),
  ('PREDICTION_2_OF_4', 0),
  ('PREDICTION_3_OF_4', 0),
  ('PREDICTION_4_OF_4', 0);
