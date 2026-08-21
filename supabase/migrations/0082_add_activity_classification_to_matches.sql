-- Migration: 0082_add_activity_classification_to_matches
-- Persistent Metagame Phase 1. Additive only — 0052 (matches) is
-- unmodified in shape, only extended.
--
-- The canonical Product Activity Classification lives at the Match
-- level for Soccer Predictions, not on venue_activations: one Gaming
-- Member has exactly one logical Prediction per Match regardless of
-- which Venue Activation it was submitted through, and a Venue
-- Activation owns venue eligibility/prize context, never the
-- competitive classification of the underlying logical activity.
-- Classifying per-activation would let the same Match be RANKED at
-- one venue and CASUAL at another, reopening the same "one logical
-- activity must not multiply persistent recognition" risk the
-- Product architecture already forbids for venue duplication.
--
-- Nullable, no default: a Match starts undeclared. Declaration
-- (set_match_activity_classification_atomically, 0083) is required
-- before upsert_prediction_atomically (0084) accepts any Prediction
-- against this Match, and becomes immutable the moment real
-- Prediction or Result evidence exists — enforced in that same
-- function, not by a trigger, matching this repository's established
-- convention of enforcing invariants inside atomic functions rather
-- than introducing a new mechanism class.

alter table matches
  add column activity_classification text null;

alter table matches
  add constraint matches_activity_classification_valid
  check (activity_classification is null or activity_classification in ('TRAINING', 'CASUAL', 'RANKED', 'OFFICIAL'));
