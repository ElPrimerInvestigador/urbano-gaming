-- Migration: 0050_create_teams
-- Soccer Predictions — corrected model (Founder UX correction, post-
-- local-playtest, superseding the original scorer/minute-multiset
-- design). A Team is the smallest reusable unit rosters and Matches
-- both reference by stable id — no league-management system, no
-- sports-API integration in this phase. A future sports-data provider
-- may later populate/sync this table; provider ids are never this
-- table's primary key, so that integration can arrive later without
-- redesigning Match/Prediction records.

create table teams (
  team_id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table teams
  add constraint teams_name_not_empty check (char_length(btrim(name)) >= 1);
