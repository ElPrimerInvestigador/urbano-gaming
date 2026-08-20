-- Migration: 0058_create_official_goal_events
-- Soccer Predictions — corrected model. The official record still
-- needs real structured goal events, even though members now make
-- only four independent picks: settlement needs to know exactly which
-- Player scored, when, and which Team the goal counts for on the
-- scoreline (own goals credit the *opposing* Team) to derive
-- Goalscorer correctness, Goal Minute correctness, and chronological
-- First Team to Score.
--
-- scorer_player_id now references the same Players roster Predictions
-- select from (0051) — admin result entry also selects a real Player,
-- never free text, on either side of the system.
--
-- No stored credited-Team column: it is derivable at settlement time
-- from is_own_goal + the scorer's own Team (0051) + the Match's own
-- home/away Team ids (0052) — "avoid redundant state if derivable"
-- applied here exactly as it was to Match's own lifecycle.
--
-- Belongs to a specific match_result_id (a Result Version), not
-- match_id directly — a correction's new goal events never overwrite
-- the original settlement's evidence; the original finalized
-- match_results row and its own official_goal_events rows are
-- immutable and untouched by a correction.
--
-- minute_regulation / minute_stoppage preserve full official fidelity
-- (e.g. 45+2 is minute_regulation=45, minute_stoppage=2) even though
-- the member-facing predicted_goal_minute (0056) is a single plain
-- integer — settlement compares against the effective total elapsed
-- minute, never a lossy collapse of the official record itself.

create table official_goal_events (
  official_goal_event_id uuid primary key default gen_random_uuid(),
  match_result_id uuid not null references match_results (match_result_id),
  scorer_player_id uuid not null references players (player_id),
  is_own_goal boolean not null default false,
  minute_regulation integer not null,
  minute_stoppage integer null,
  ordinal integer not null,
  created_at timestamptz not null default now(),
  unique (match_result_id, ordinal)
);

alter table official_goal_events
  add constraint official_goal_events_minute_regulation_range
  check (minute_regulation between 1 and 120);
alter table official_goal_events
  add constraint official_goal_events_minute_stoppage_positive
  check (minute_stoppage is null or minute_stoppage > 0);

create index official_goal_events_match_result_id_idx on official_goal_events (match_result_id);
create index official_goal_events_scorer_player_id_idx on official_goal_events (scorer_player_id);
