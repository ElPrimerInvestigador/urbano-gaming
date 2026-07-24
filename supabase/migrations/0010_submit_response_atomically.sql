-- Migration: 0010_submit_response_atomically
-- Purpose:
-- Re-verify the supplied participant token belongs to the given
-- participant of this session, that the session is PROMPT_ACTIVE, then
-- upsert the participant's response to the session's current prompt
-- (one submission per participant per prompt — a second call replaces
-- the first) and persist a RESPONSE_SUBMITTED event — all as one
-- atomic operation.
--
-- "Last write wins" is an explicit MVP implementation decision, not a
-- permanent gameplay rule — future product validation may determine
-- immutable submissions or a different revision policy.
--
-- Transactional guarantee:
-- If any step fails, PostgreSQL rolls back the entire function call.
--
-- Session-state and participant-token authority:
-- The session row is locked (SELECT ... FOR UPDATE) before the state
-- check, closing the race window between an application-layer lookup
-- and this write — the same reasoning as join_participant_atomically
-- (0004 migration), applied here to prevent a submission landing after
-- a concurrent CLOSE_SUBMISSIONS. The participant token is re-verified
-- against this specific session_id and participant_id, not merely
-- trusted from an earlier, non-authoritative caller-side check.
--
-- current_prompt_id is read from the locked session row, not supplied
-- by the caller — the session's current prompt is always the
-- authoritative target, never a client-suggested one.
--
-- A session that no longer exists, a token that doesn't match the
-- given participant of this session, or a session that is not
-- PROMPT_ACTIVE raises a distinct, named exception (SESSION_NOT_FOUND
-- / SESSION_ACCESS_DENIED / PROMPT_NOT_ACTIVE) rather than being
-- inferred from a generic error. The calling adapter translates these
-- explicitly.

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
