-- Migration: 0009_create_submissions
-- Scope: SUBMIT_RESPONSE vertical slice only.
--
-- A Submission is deliberately minimal for the MVP: who submitted it,
-- which prompt it answers, and the free-text response. No scoring, no
-- media, no categories, no validation beyond a reasonable non-empty
-- length check (enforced at the domain layer, mirroring the
-- display-name floor).
--
-- One submission per participant per prompt, enforced by a unique
-- index scoped to (session_id, participant_id, prompt_id) rather than
-- just (session_id, participant_id) — there is only ever one prompt
-- per session in this MVP (current_prompt_id), but this shape works
-- unchanged once a future "rounds" concept introduces multiple prompts
-- per session, without a schema redesign.
--
-- "Last write wins" (a participant may revise their response while the
-- session remains PROMPT_ACTIVE, replacing the previous one) is
-- implemented via submit_response_atomically's upsert — see
-- 0010_submit_response_atomically.sql. This is an explicit MVP
-- implementation decision, not a permanent gameplay rule; future
-- product validation may determine immutable submissions or a
-- different revision policy.

create table if not exists submissions (
  submission_id  uuid primary key default gen_random_uuid(),
  session_id     uuid not null references sessions(session_id) on delete cascade,
  participant_id uuid not null references participants(participant_id) on delete cascade,
  prompt_id      uuid not null references prompts(prompt_id),
  text           text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists submissions_session_participant_prompt_unique
  on submissions (session_id, participant_id, prompt_id);
