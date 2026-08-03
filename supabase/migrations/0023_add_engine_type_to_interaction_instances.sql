-- Migration: 0023_add_engine_type_to_interaction_instances
-- Slice 003 — Second Interaction Engine (Multiple Choice Trivia).
--
-- Every interaction instance so far has implicitly been Open Response,
-- because it was the only engine that existed — nothing in the schema
-- ever had to say so. This column makes that explicit and becomes the
-- single source of truth for which engine an interaction instance
-- belongs to, rather than inferring it from which engine-specific
-- extension table happens to have a matching row (see
-- multiple_choice_details in 0024).
--
-- Additive only: existing rows backfill to 'OPEN_RESPONSE', which is
-- correct for every row that exists today, since no other engine has
-- ever produced one.

alter table interaction_instances
  add column if not exists engine_type text not null default 'OPEN_RESPONSE';

alter table interaction_instances
  add constraint interaction_instances_engine_type_valid_values
  check (engine_type in ('OPEN_RESPONSE', 'MULTIPLE_CHOICE'));
