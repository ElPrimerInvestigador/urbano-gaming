-- Migration: 0026_start_session_atomically_explicit_prepared_question
-- Slice 003 — Second Interaction Engine (Multiple Choice Trivia).
--
-- START_SESSION gains an optional p_prepared_question_id parameter.
-- Deliberately explicit rather than an implicit "if unconsumed
-- prepared questions exist, use the next one" fallback: the caller
-- names the exact question being started, so the request's meaning
-- never depends on hidden repository state. The host UI may still
-- present one "Start next question" button that auto-selects the
-- lowest unconsumed ordinal client-side (see GET_SESSION's
-- preparedQuestions field) — but the request sent to this function
-- always carries the specific target.
--
--   p_prepared_question_id supplied  -> start that Multiple Choice
--                                       question, ignore p_prompt_text
--   p_prepared_question_id null      -> existing Open Response path,
--                                       unchanged, p_prompt_text required
--
-- Both p_prompt_text and p_prepared_question_id are given defaults so
-- exactly one is meaningfully supplied per call; the domain layer
-- enforces that contract before calling this function, and this
-- function re-enforces it authoritatively via the empty-prompt-text
-- check in the Open Response branch.
--
-- Signature change (3 args -> 4) and return-shape change (adds
-- engine_type) both require the drop-then-create pattern established
-- in 0017-0020 and reused in 0022 — Postgres refuses CREATE OR REPLACE
-- across either kind of change.
--
-- Column-list ambiguity: same bug class as every prior migration in
-- this family (0014, 0017-0020, 0022) — #variable_conflict use_column
-- resolves it identically.

drop function if exists start_session_atomically(uuid, text, text);

create function start_session_atomically(
  p_session_id uuid,
  p_host_token text,
  p_prompt_text text default null,
  p_prepared_question_id uuid default null
)
returns table (
  interaction_instance_id uuid,
  prompt_id uuid,
  state text,
  engine_type text
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
  v_prompt_id uuid;
  v_interaction_instance_id uuid;
  v_engine_type text;
  v_prepared_session_id uuid;
  v_prepared_prompt_text text;
  v_prepared_options jsonb;
  v_prepared_correct_option_index integer;
  v_prepared_points_for_correct integer;
  v_prepared_consumed_at timestamptz;
begin
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

  if p_prepared_question_id is not null then
    select prepared_questions.session_id, prepared_questions.prompt_text,
           prepared_questions.options, prepared_questions.correct_option_index,
           prepared_questions.points_for_correct, prepared_questions.consumed_at
      into v_prepared_session_id, v_prepared_prompt_text, v_prepared_options,
           v_prepared_correct_option_index, v_prepared_points_for_correct,
           v_prepared_consumed_at
    from prepared_questions
    where prepared_questions.prepared_question_id = p_prepared_question_id
    for update;

    if v_prepared_session_id is null or v_prepared_session_id <> p_session_id then
      raise exception 'PREPARED_QUESTION_NOT_FOUND: no prepared question exists for this id in this session'
        using errcode = 'P0001';
    end if;

    if v_prepared_consumed_at is not null then
      raise exception 'PREPARED_QUESTION_ALREADY_CONSUMED: this prepared question has already been started'
        using errcode = 'P0001';
    end if;

    insert into prompts (text)
    values (v_prepared_prompt_text)
    returning prompts.prompt_id into v_prompt_id;

    insert into interaction_instances (session_id, prompt_id, state, engine_type)
    values (p_session_id, v_prompt_id, 'PROMPT_ACTIVE', 'MULTIPLE_CHOICE')
    returning interaction_instances.interaction_instance_id into v_interaction_instance_id;

    insert into multiple_choice_details (
      interaction_instance_id, options, correct_option_index, points_for_correct
    )
    values (
      v_interaction_instance_id, v_prepared_options, v_prepared_correct_option_index,
      v_prepared_points_for_correct
    );

    update prepared_questions
    set consumed_at = now()
    where prepared_questions.prepared_question_id = p_prepared_question_id;

    v_engine_type := 'MULTIPLE_CHOICE';
  else
    if btrim(coalesce(p_prompt_text, '')) = '' then
      raise exception 'EMPTY_PROMPT_TEXT: prompt text cannot be empty'
        using errcode = 'P0001';
    end if;

    insert into prompts (text)
    values (btrim(p_prompt_text))
    returning prompts.prompt_id into v_prompt_id;

    insert into interaction_instances (session_id, prompt_id, state, engine_type)
    values (p_session_id, v_prompt_id, 'PROMPT_ACTIVE', 'OPEN_RESPONSE')
    returning interaction_instances.interaction_instance_id into v_interaction_instance_id;

    v_engine_type := 'OPEN_RESPONSE';
  end if;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'INTERACTION_STARTED',
    jsonb_build_object(
      'interactionInstanceId', v_interaction_instance_id,
      'promptId', v_prompt_id,
      'engineType', v_engine_type
    )
  );

  return query select v_interaction_instance_id, v_prompt_id, 'PROMPT_ACTIVE'::text, v_engine_type;
end;
$$;
