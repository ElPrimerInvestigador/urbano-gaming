-- Migration: 0043_create_submit_quiz_response_atomically
-- Quiz Experience — dedicated Submit Quiz Response operation.
--
-- Deliberately NOT a generalization of submit_response_atomically,
-- which continues to resolve its target as "the most recently created
-- Interaction Instance for this session" completely unchanged, for
-- Open Response, Trivia, and Voting alike. Quiz participants must be
-- able to target any one of N simultaneously-PROMPT_ACTIVE question
-- Interaction Instances independently — a shape submit_response_atomically
-- was never built for and is not modified to support here. See the
-- accepted implementation-readiness design's Seam 2 resolution for the
-- full reasoning (code duplication here is small and consistent with
-- this schema's own per-command-function convention; the alternative
-- risked a standing maintenance hazard inside the platform's single
-- most heavily-relied-upon function).
--
-- Authoritative validation, all inside one row-locked transaction:
-- participant token belongs to the named participant of this session;
-- the target Interaction Instance belongs to this session; its engine
-- is MULTIPLE_CHOICE; its Segment has a quiz_windows row (i.e. it is
-- actually a Quiz question, not a Trivia/Open Response/Voting
-- instance mistakenly targeted through this path); its own state is
-- PROMPT_ACTIVE; the Quiz window is not closed and the database's own
-- clock has not yet reached closes_at (this, not any per-instance
-- state, is the authoritative late-submission rejection — see 0041's
-- header comment for why); and the selected option index is within
-- bounds for that question. Every one of these is deliberately
-- collapsed into the same "not found / not eligible" error family the
-- rest of this schema already uses (mirrors submit_response_atomically
-- and cast_vote_atomically's own refusal to reveal which specific part
-- of a combined check failed).
--
-- Reuses the existing `submissions` table and its existing
-- (interaction_instance_id, participant_id) upsert/"last write wins"
-- semantics completely unchanged — a Quiz answer is not a new kind of
-- data, only a new, independently-addressable target.

create function submit_quiz_response_atomically(
  p_session_id uuid,
  p_participant_id uuid,
  p_participant_token text,
  p_interaction_instance_id uuid,
  p_selected_option_index integer
)
returns table (submission_id uuid, interaction_instance_id uuid, updated_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_exists uuid;
  v_participant_match uuid;
  v_instance_session_id uuid;
  v_instance_segment_id uuid;
  v_instance_engine_type text;
  v_instance_state text;
  v_prompt_id uuid;
  v_closes_at timestamptz;
  v_closed_at timestamptz;
  v_option_count integer;
  v_submission_id uuid;
  v_updated_at timestamptz;
begin
  select sessions.session_id into v_session_exists
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_session_exists is null then
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

  select interaction_instances.session_id, interaction_instances.segment_id,
         interaction_instances.engine_type, interaction_instances.state,
         interaction_instances.prompt_id
    into v_instance_session_id, v_instance_segment_id, v_instance_engine_type,
         v_instance_state, v_prompt_id
  from interaction_instances
  where interaction_instances.interaction_instance_id = p_interaction_instance_id
  for update;

  if v_instance_session_id is null
     or v_instance_session_id <> p_session_id
     or v_instance_engine_type <> 'MULTIPLE_CHOICE' then
    raise exception 'QUIZ_INSTANCE_NOT_FOUND: target question does not belong to an active Quiz in this session'
      using errcode = 'P0001';
  end if;

  select quiz_windows.closes_at, quiz_windows.closed_at
    into v_closes_at, v_closed_at
  from quiz_windows
  where quiz_windows.segment_id = v_instance_segment_id
  for update;

  if v_closes_at is null then
    raise exception 'QUIZ_INSTANCE_NOT_FOUND: target question does not belong to an active Quiz in this session'
      using errcode = 'P0001';
  end if;

  if v_instance_state <> 'PROMPT_ACTIVE' then
    raise exception 'QUIZ_CLOSED: this Quiz is closed and no longer accepting submissions'
      using errcode = 'P0001';
  end if;

  if v_closed_at is not null or now() >= v_closes_at then
    raise exception 'QUIZ_CLOSED: this Quiz is closed and no longer accepting submissions'
      using errcode = 'P0001';
  end if;

  select jsonb_array_length(multiple_choice_details.options) into v_option_count
  from multiple_choice_details
  where multiple_choice_details.interaction_instance_id = p_interaction_instance_id;

  if p_selected_option_index is null
     or p_selected_option_index < 0
     or p_selected_option_index >= coalesce(v_option_count, 0) then
    raise exception 'INVALID_OPTION_SELECTION: selected option index is not valid for this question'
      using errcode = 'P0001';
  end if;

  insert into submissions (session_id, participant_id, prompt_id, interaction_instance_id, text)
  values (p_session_id, p_participant_id, v_prompt_id, p_interaction_instance_id, p_selected_option_index::text)
  on conflict (interaction_instance_id, participant_id)
  do update set text = excluded.text, updated_at = now()
  returning submissions.submission_id, submissions.updated_at
  into v_submission_id, v_updated_at;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'QUIZ_RESPONSE_SUBMITTED',
    jsonb_build_object(
      'participantId', p_participant_id,
      'interactionInstanceId', p_interaction_instance_id
    )
  );

  return query select v_submission_id, p_interaction_instance_id, v_updated_at;
end;
$$;
