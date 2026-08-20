-- Migration: 0052_create_matches
-- Soccer Predictions. References Teams by stable id (not free text) —
-- required so a Match's own roster (the two Teams' selectable
-- Players) can be resolved cleanly for the Goalscorer prediction UI.
--
-- No status column: the full lifecycle (scheduled / locked / drafted
-- / finalized / cancelled) is derivable from kickoff_at, cancelled_at,
-- and match_results.finalized_at — mirrors Quiz's own closes_at/
-- closed_at precedent. No league-table, roster-history, or Lifestyle
-- linkage.

create table matches (
  match_id uuid primary key default gen_random_uuid(),
  home_team_id uuid not null references teams (team_id),
  away_team_id uuid not null references teams (team_id),
  competition text not null,
  kickoff_at timestamptz not null,
  cancelled_at timestamptz null,
  created_at timestamptz not null default now()
);

alter table matches
  add constraint matches_competition_not_empty check (char_length(btrim(competition)) >= 1);
alter table matches
  add constraint matches_teams_distinct check (home_team_id <> away_team_id);

create index matches_home_team_id_idx on matches (home_team_id);
create index matches_away_team_id_idx on matches (away_team_id);
