-- Migration: 0030_add_voting_engine_type
-- Slice 007 — Voting Engine (Proving Case).
--
-- Adds 'VOTING' to interaction_instances.engine_type's permitted
-- values, mirroring 0023's exact treatment of 'MULTIPLE_CHOICE':
-- enum/constraint extension is always its own migration in this
-- repository, independent of the extension table(s) that follow it.
--
-- Postgres has no ALTER CHECK — the existing constraint is dropped and
-- recreated with the wider value set, additive only. No existing row's
-- engine_type is affected.

alter table interaction_instances
  drop constraint interaction_instances_engine_type_valid_values;

alter table interaction_instances
  add constraint interaction_instances_engine_type_valid_values
  check (engine_type in ('OPEN_RESPONSE', 'MULTIPLE_CHOICE', 'VOTING'));
