-- Migration: 0014_fix_submit_response_ambiguous_prompt_id
-- Purpose:
-- Fix a second real bug discovered only through live execution against
-- a real Postgres database: submit_response_atomically (0010) declares
-- RETURNS TABLE (submission_id uuid, prompt_id uuid, updated_at
-- timestamptz), creating an implicit OUT parameter named `prompt_id`.
-- The function's `INSERT INTO submissions (..., prompt_id, ...)`
-- column list and its `ON CONFLICT (..., prompt_id)` target list both
-- reference `prompt_id` unqualified — and unlike a plain SELECT, these
-- two positions cannot be fixed by table-qualifying the identifier
-- (`insert into t (a, b)` and `on conflict (a, b)` do not accept
-- table-qualified column names in standard SQL syntax at all). Postgres
-- raises "column reference is ambiguous" (SQLSTATE 42702) at execution
-- time, the same class of bug fixed in 0013 for five other functions,
-- but requiring a different fix here since qualification isn't
-- syntactically available.
--
-- Fix: add the `#variable_conflict use_column` pragma, PL/pgSQL's
-- documented mechanism for exactly this situation — it tells the
-- function to resolve any remaining ambiguous bare identifier in favor
-- of the SQL column rather than raising an error, for the entire
-- function body. This is safe here because every ambiguous identifier
-- in this function is one where the table column is what's actually
-- intended (that's why the ambiguity exists — the code is reading from
-- or targeting the table); local variables are already consistently
-- v_-prefixed and never collide with anything, so the pragma cannot
-- accidentally shadow an intended variable reference.
--
-- Per this repository's migration-immutability discipline, 0010 is
-- left as-is; this fixes it forward via CREATE OR REPLACE FUNCTION.

create or replace function submit_response_atomically(
  p_session_id uuid,
  p_participant_id uuid,
  p_participant_token text,
  p_text text
)
returns table (submission_id uuid, prompt_id uuid, updated_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_state text;
  v_prompt_id uuid;
  v_participant_match uuid;
  v_submission_id uuid;
  v_updated_at timestamptz;
begin
  select state, current_prompt_id
    into v_state, v_prompt_id
  from sessions
  where session_id = p_session_id
  for update;

  if v_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  select participant_id into v_participant_match
  from participants
  where participant_id = p_participant_id
    and session_id = p_session_id
    and participant_token = p_participant_token;

  if v_participant_match is null then
    raise exception 'SESSION_ACCESS_DENIED: participant token does not match this participant and session'
      using errcode = 'P0001';
  end if;

  if v_state <> 'PROMPT_ACTIVE' then
    raise exception 'PROMPT_NOT_ACTIVE: session is in % state, not PROMPT_ACTIVE', v_state
      using errcode = 'P0001';
  end if;

  insert into submissions (session_id, participant_id, prompt_id, text)
  values (p_session_id, p_participant_id, v_prompt_id, p_text)
  on conflict (session_id, participant_id, prompt_id)
  do update set text = excluded.text, updated_at = now()
  returning submissions.submission_id, submissions.updated_at
  into v_submission_id, v_updated_at;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'RESPONSE_SUBMITTED',
    jsonb_build_object('participantId', p_participant_id, 'promptId', v_prompt_id)
  );

  return query select v_submission_id, v_prompt_id, v_updated_at;
end;
$$;
