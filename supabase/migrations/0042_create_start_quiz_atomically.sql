-- Migration: 0042_create_start_quiz_atomically
-- Quiz Experience — dedicated Start Quiz operation.
--
-- Deliberately NOT a generalization of start_session_atomically. The
-- accepted implementation-readiness design chose dedicated Quiz
-- commands specifically so this function could carry Quiz-only
-- concerns (bulk question consumption, a computed deadline, N
-- Interaction Instances created together) with zero risk to
-- start_session_atomically's existing, production-validated behavior
-- for Open Response, Multiple Choice Trivia, and Voting. That function
-- is untouched by this migration.
--
-- In one transaction: authenticate the host, verify the session is
-- LOBBY_LOCKED and has no un-revealed current interaction (the same
-- precondition NEW_SEGMENT already enforces — a Quiz always opens a
-- brand new Segment, never CURRENT_SEGMENT, since there is no
-- "continue the Quiz's own Segment" concept), allocate a new Segment,
-- compute closes_at from the database's own clock (never trusting a
-- client-supplied timestamp), consume every currently-unconsumed
-- prepared question for this session (row-locked, so a concurrent
-- START_QUIZ cannot double-consume the same queue), and create one
-- Multiple Choice Interaction Instance + multiple_choice_details row
-- per question, all belonging to the new Segment and all PROMPT_ACTIVE
-- from the moment they're created — never created lazily, so there is
-- no question-identity race between two participants reaching the same
-- question first (see the accepted design's Seam 3 resolution).
--
-- Returns one row per created question (interaction_instance_id,
-- prompt_id, ordinal, segment_id, segment_ordinal, closes_at) — the
-- caller aggregates segment_id/segment_ordinal/closes_at (identical on
-- every row) and collects the per-question ids.
--
-- Duration bound (30-3600 seconds) is re-validated here, authoritatively,
-- even though the domain layer also checks it before calling this
-- function — mirrors EMPTY_PROMPT_TEXT's existing double-checked
-- pattern elsewhere in this schema (domain-layer convenience check,
-- SQL-layer authority).

create function start_quiz_atomically(
  p_session_id uuid,
  p_host_token text,
  p_duration_seconds integer
)
returns table (
  interaction_instance_id uuid,
  prompt_id uuid,
  ordinal integer,
  segment_id uuid,
  segment_ordinal integer,
  closes_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_state text;
  v_host_token text;
  v_previous_interaction_instance_id uuid;
  v_previous_interaction_state text;
  v_segment_id uuid;
  v_segment_ordinal integer;
  v_closes_at timestamptz;
  v_prompt_id uuid;
  v_interaction_instance_id uuid;
  v_question_count integer := 0;
  r record;
begin
  if p_duration_seconds is null or p_duration_seconds < 30 or p_duration_seconds > 3600 then
    raise exception 'INVALID_QUIZ_DURATION: duration must be between 30 and 3600 seconds'
      using errcode = 'P0001';
  end if;

  select sessions.state, sessions.host_token
    into v_session_state, v_host_token
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_session_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if v_session_state <> 'LOBBY_LOCKED' then
    raise exception 'LOBBY_NOT_LOCKED: session is in % state, not LOBBY_LOCKED', v_session_state
      using errcode = 'P0001';
  end if;

  select interaction_instances.interaction_instance_id, interaction_instances.state
    into v_previous_interaction_instance_id, v_previous_interaction_state
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1
  for update;

  if v_previous_interaction_instance_id is not null
     and v_previous_interaction_state <> 'RESULT_REVEAL' then
    raise exception 'PREVIOUS_INTERACTION_NOT_REVEALED: current interaction is in % state, not RESULT_REVEAL', v_previous_interaction_state
      using errcode = 'P0001';
  end if;

  -- Fail fast, before creating any Segment/window row, when there is
  -- nothing to build a Quiz from.
  if not exists (
    select 1 from prepared_questions
    where prepared_questions.session_id = p_session_id
      and prepared_questions.consumed_at is null
  ) then
    raise exception 'EMPTY_QUIZ_QUESTION_SET: no unconsumed prepared questions exist to start a Quiz'
      using errcode = 'P0001';
  end if;

  -- Executes after the session-row lock above is already held, the
  -- same discipline start_session_atomically's NEW_SEGMENT path relies
  -- on (see 0037) — safe as a plain read for the same reason.
  select coalesce(max(segments.segment_ordinal), 0) + 1 into v_segment_ordinal
  from segments
  where segments.session_id = p_session_id;

  insert into segments (session_id, segment_ordinal)
  values (p_session_id, v_segment_ordinal)
  returning segments.segment_id into v_segment_id;

  v_closes_at := now() + make_interval(secs => p_duration_seconds);

  insert into quiz_windows (segment_id, closes_at)
  values (v_segment_id, v_closes_at);

  for r in
    select prepared_questions.prepared_question_id, prepared_questions.ordinal,
           prepared_questions.prompt_text, prepared_questions.options,
           prepared_questions.correct_option_index, prepared_questions.points_for_correct
    from prepared_questions
    where prepared_questions.session_id = p_session_id
      and prepared_questions.consumed_at is null
    order by prepared_questions.ordinal
    for update
  loop
    insert into prompts (text)
    values (r.prompt_text)
    returning prompts.prompt_id into v_prompt_id;

    insert into interaction_instances (session_id, segment_id, prompt_id, state, engine_type)
    values (p_session_id, v_segment_id, v_prompt_id, 'PROMPT_ACTIVE', 'MULTIPLE_CHOICE')
    returning interaction_instances.interaction_instance_id into v_interaction_instance_id;

    insert into multiple_choice_details (
      interaction_instance_id, options, correct_option_index, points_for_correct
    )
    values (
      v_interaction_instance_id, r.options, r.correct_option_index, r.points_for_correct
    );

    update prepared_questions
    set consumed_at = now()
    where prepared_questions.prepared_question_id = r.prepared_question_id;

    v_question_count := v_question_count + 1;

    interaction_instance_id := v_interaction_instance_id;
    prompt_id := v_prompt_id;
    ordinal := r.ordinal;
    segment_id := v_segment_id;
    segment_ordinal := v_segment_ordinal;
    closes_at := v_closes_at;
    return next;
  end loop;

  -- Defense in depth: the fail-fast check above already guarantees at
  -- least one row was locked and consumed by this point, but a
  -- concurrent consumer of the exact same rows is structurally
  -- impossible here anyway (FOR UPDATE above already serializes
  -- against it) — this simply documents the invariant rather than
  -- re-deriving it.
  assert v_question_count > 0, 'unreachable: EMPTY_QUIZ_QUESTION_SET should have fired earlier';

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'QUIZ_STARTED',
    jsonb_build_object(
      'segmentId', v_segment_id,
      'questionCount', v_question_count,
      'closesAt', v_closes_at
    )
  );

  return;
end;
$$;
