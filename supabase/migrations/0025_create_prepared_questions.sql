-- Migration: 0025_create_prepared_questions
-- Slice 003 — Second Interaction Engine (Multiple Choice Trivia).
--
-- A session-scoped queue of Multiple Choice questions authored by the
-- host before (or during) the session, independent of Interaction
-- Instance entirely. This exists specifically so the host can prepare
-- a full question set up front, review it, then progress through it
-- one interaction at a time — rather than typing each question live,
-- the way Open Response's START_SESSION already works.
--
-- ordinal is a genuinely new kind of thing for this codebase: Slice
-- 001 deliberately avoided a stored sequence number on
-- interaction_instances because instances are created one at a time
-- and creation order already is presentation order (see 0015's
-- comment). That reasoning does not transfer here — these rows are
-- authored in a batch, so creation order does not reliably reflect the
-- order the host wants to ask them in, and a stored ordinal is
-- required rather than redundant.
--
-- correct_option_index is private state, identical in kind to
-- multiple_choice_details' column of the same name: known to the
-- system and the host from authoring time, and must never reach a
-- participant through GET_SESSION before (or unless) the corresponding
-- interaction instance reaches RESULT_REVEAL. See 0024's comment.
--
-- consumed_at is set the moment a prepared question is turned into a
-- real interaction instance (see 0026) — from then on it is historical
-- record, not an active queue entry. A prepared question is never
-- deleted or reused.

create table if not exists prepared_questions (
  prepared_question_id  uuid primary key default gen_random_uuid(),
  session_id             uuid not null references sessions(session_id) on delete cascade,
  ordinal                integer not null,
  prompt_text            text not null,
  options                jsonb not null,
  correct_option_index   integer not null,
  points_for_correct     integer not null,
  consumed_at            timestamptz,
  created_at             timestamptz not null default now(),

  constraint prepared_questions_prompt_text_not_empty check (btrim(prompt_text) <> ''),
  constraint prepared_questions_options_shape check (
    jsonb_typeof(options) = 'array' and jsonb_array_length(options) >= 2
  ),
  constraint prepared_questions_correct_option_index_bounds check (
    correct_option_index >= 0 and correct_option_index < jsonb_array_length(options)
  ),
  constraint prepared_questions_points_for_correct_bounds check (
    points_for_correct > 0 and points_for_correct <= 10000
  )
);

create unique index if not exists prepared_questions_session_ordinal_unique
  on prepared_questions (session_id, ordinal);

-- Supports the one query pattern this feature needs: "the lowest
-- unconsumed ordinal for this session."
create index if not exists prepared_questions_session_unconsumed_idx
  on prepared_questions (session_id, ordinal)
  where consumed_at is null;
