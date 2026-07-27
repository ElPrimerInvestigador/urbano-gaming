-- Migration: 0017_submit_response_atomically_interaction_scoped
-- Slice 001 — Session / Interaction separation.
--
-- Re-scopes SUBMIT_RESPONSE's authoritative check from the session's
-- own state to the session's current interaction instance. Same
-- signature as 0010/0014 (no caller-visible input change) — only the
-- returned shape and the internal precondition change.
--
-- Session state must still be LOBBY_LOCKED (this is the only state
-- during which any interaction may accept input) *and* the current
-- interaction instance (the most recently created one for this
-- session, resolved and row-locked here — mirroring
-- join_participant_atomically's and every other function's row-locked
-- re-check discipline) must be PROMPT_ACTIVE. Checking session state
-- as well as interaction state matters specifically because
-- COMPLETE_SESSION remains callable at any point, including mid
-- interaction — a completed session must reject submissions even if
-- its last interaction instance is still sitting at PROMPT_ACTIVE.
--
-- Column-list and ON CONFLICT-target ambiguity: this function's INSERT
-- column list and its ON CONFLICT target both include prompt_id and
-- interaction_instance_id, which collide with this function's own
-- RETURNS TABLE output parameter names of the same names — the exact
-- bug class fixed in 0014, for the same underlying reason (these
-- positions cannot be table-qualified in standard SQL syntax).
-- #variable_conflict use_column resolves it the same way, for the
-- same reason: every ambiguous bare identifier here is intentionally
-- reading from or targeting the table, and local variables are
-- consistently v_-prefixed so the pragma cannot shadow anything.
--
-- Per migration-immutability discipline, 0010 and 0014 are left as-is;
-- this fixes/generalizes forward via a new migration.
--
-- Return-shape change: this function's RETURNS TABLE now includes
-- interaction_instance_id as an output column, which the prior
-- (submission_id, prompt_id, updated_at) shape did not have. Postgres
-- refuses to CREATE OR REPLACE a function across a change to its
-- output row type ("cannot change return type of existing function"),
-- even when the argument list is unchanged — only same-signature *and*
-- same-return-shape changes qualify for CREATE OR REPLACE. This is the
-- same constraint 0020 already accounts for on its argument-list
-- change; the prior 3-argument version here is dropped explicitly,
-- then the same-arity, new-return-shape version is created.

drop function if exists submit_response_atomically(uuid, uuid, text, text);

create function submit_response_atomically(
  p_session_id uuid,
  p_participant_id uuid,
  p_participant_token text,
  p_text text
)
returns table (submission_id uuid, interaction_instance_id uuid, prompt_id uuid, updated_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_state text;
  v_participant_match uuid;
  v_interaction_instance_id uuid;
  v_prompt_id uuid;
  v_interaction_state text;
  v_submission_id uuid;
  v_updated_at timestamptz;
begin
  select sessions.state into v_session_state
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_session_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  select participants.participant_id into v_participant_match
  from participants
  where participants.participant_id = p_participant_id
    and participants.session_id = p_session_id
    and participants.participant_token = p_participant_token;

  if v_participant_match is null then
    raise exception 'SESSION_ACCESS_DENIED: participant token does not match this participant and session'
      using errcode = 'P0001';
  end if;

  -- Resolve and lock the current interaction instance: the most
  -- recently created one for this session. Row-locked so a concurrent
  -- close cannot race past this check.
  select interaction_instances.interaction_instance_id,
         interaction_instances.prompt_id,
         interaction_instances.state
    into v_interaction_instance_id, v_prompt_id, v_interaction_state
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1
  for update;

  if v_session_state <> 'LOBBY_LOCKED'
     or v_interaction_instance_id is null
     or v_interaction_state <> 'PROMPT_ACTIVE' then
    raise exception 'PROMPT_NOT_ACTIVE: no interaction is currently PROMPT_ACTIVE for this session'
      using errcode = 'P0001';
  end if;

  insert into submissions (session_id, participant_id, prompt_id, interaction_instance_id, text)
  values (p_session_id, p_participant_id, v_prompt_id, v_interaction_instance_id, p_text)
  on conflict (interaction_instance_id, participant_id)
  do update set text = excluded.text, updated_at = now()
  returning submissions.submission_id, submissions.updated_at
  into v_submission_id, v_updated_at;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'RESPONSE_SUBMITTED',
    jsonb_build_object(
      'participantId', p_participant_id,
      'interactionInstanceId', v_interaction_instance_id,
      'promptId', v_prompt_id
    )
  );

  return query select v_submission_id, v_interaction_instance_id, v_prompt_id, v_updated_at;
end;
$$;
