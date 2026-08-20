-- Migration: 0051_create_players
-- Soccer Predictions. The selectable roster a member picks a
-- Goalscorer prediction from, and admin picks an official scorer from
-- — no free-text player entry anywhere, on either side, per the
-- Founder's explicit correction. No transfers/contracts/profiles: a
-- Player belongs to exactly one Team at a time; "removing" a player
-- from selectability is `active = false`, never a delete — this
-- table has no delete code path anywhere in this phase specifically
-- so a Prediction's or an official goal event's `player_id` reference
-- can never dangle. A deactivated player remains fully resolvable for
-- historical display; only NEW selection is filtered by `active`.

create table players (
  player_id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (team_id),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table players
  add constraint players_name_not_empty check (char_length(btrim(name)) >= 1);

create index players_team_id_idx on players (team_id);
