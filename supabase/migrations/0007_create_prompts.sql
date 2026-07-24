-- Migration: 0007_create_prompts
-- Scope: START_SESSION vertical slice only.
--
-- A Prompt is, for the MVP, deliberately minimal: an id and a single
-- piece of text shown to all participants. No media, no types, no
-- categories, no per-round configuration — those are all future
-- capability, not modeled here, per the accompanying design
-- clarification.
--
-- Seeded with exactly one row: an engineering seed prompt whose only
-- purpose is validating the START_SESSION transition, persistence
-- model, and GET_SESSION integration. Not production copy — replace
-- freely without any architectural impact.

create table if not exists prompts (
  prompt_id  uuid primary key default gen_random_uuid(),
  text       text not null,
  created_at timestamptz not null default now()
);

insert into prompts (text) values (
  '[ENGINEERING SEED PROMPT — placeholder, not production copy] What''s one thing you''re looking forward to this week?'
);
