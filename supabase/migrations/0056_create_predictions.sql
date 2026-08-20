-- Migration: 0056_create_predictions
-- Soccer Predictions — corrected model. Superseded design (never
-- committed, never applied beyond a local dev database, never
-- accepted): full scorer/minute-multiset reconstruction with a
-- goal-count invariant. Founder UX correction after live local
-- playtest: four independent, low-friction picks — Scoreline,
-- Goalscorer, Goal Minute, First Team to Score. No goal-count
-- invariant, no free-text scorer entry, no per-goal reconstruction.
--
-- predicted_goalscorer_player_id: one Player, selected from the
-- Match's own two-Team roster (enforced by upsert_prediction_atomically,
-- not expressible as a plain CHECK) — never free text. NULL means the
-- member explicitly predicted "No Goalscorer" (i.e. no goal at all);
-- every Prediction answers all four dimensions at submission time, so
-- NULL is never an "unanswered" ambiguity, only a deliberate choice.
--
-- predicted_goal_minute: a single plain integer, the member's own
-- pick from a simple mobile-friendly range — deliberately NOT asked
-- to distinguish regulation/stoppage time themselves (that fidelity
-- is preserved on the *official* side, 0058, where it is a real fact
-- to record, not a guess). Settlement compares this against each
-- official goal's own effective total elapsed minute
-- (minute_regulation + minute_stoppage), so a member predicting a
-- late-stoppage goal simply picks the larger effective number (e.g.
-- 93 for what would display as 90+3) — no ambiguity is lost, only the
-- member-facing distinction between "which period" is. NULL means "No
-- Goal" predicted.
--
-- predicted_first_team_to_score: 'HOME' | 'AWAY' | NULL ('No Goal').
-- Relative to the Match's own home/away designation rather than a
-- second Team-id reference, matching how the dimension is actually
-- asked ("who scores first," not "which of these two arbitrary
-- teams").
--
-- UNIQUE(match_id, gaming_member_id): one Prediction per Gaming Member
-- per Match, globally — unchanged anti-farming mechanism, still not
-- scoped to venue_activation_id.

create table predictions (
  prediction_id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches (match_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  venue_activation_id uuid not null references venue_activations (venue_activation_id),
  predicted_home_score integer not null,
  predicted_away_score integer not null,
  predicted_goalscorer_player_id uuid null references players (player_id),
  predicted_goal_minute integer null,
  predicted_first_team_to_score text null,
  geo_verified_at timestamptz not null,
  measured_distance_meters numeric not null,
  reported_accuracy_meters numeric null,
  geo_eligible boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, gaming_member_id)
);

alter table predictions
  add constraint predictions_scores_non_negative
  check (predicted_home_score >= 0 and predicted_away_score >= 0);

alter table predictions
  add constraint predictions_goal_minute_range
  check (predicted_goal_minute is null or predicted_goal_minute between 1 and 120);

alter table predictions
  add constraint predictions_first_team_valid
  check (predicted_first_team_to_score is null or predicted_first_team_to_score in ('HOME', 'AWAY'));

create index predictions_match_id_idx on predictions (match_id);
create index predictions_gaming_member_id_idx on predictions (gaming_member_id);
create index predictions_venue_activation_id_idx on predictions (venue_activation_id);
create index predictions_goalscorer_player_id_idx on predictions (predicted_goalscorer_player_id);
