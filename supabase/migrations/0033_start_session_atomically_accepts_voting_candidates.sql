-- Migration: 0033_start_session_atomically_accepts_voting_candidates
-- Slice 007 — Voting Engine (Proving Case).
--
-- START_SESSION gains three new optional parameters carrying Voting's
-- Candidate Resolution input, decomposed at the SupabaseSessionRepository
-- boundary from one structured TypeScript union (VotingCandidateSource)
-- into flat SQL parameters — Postgres has no native discriminated-union
-- type, and this repository's existing convention (multiple_choice_details.options
-- as a single jsonb column, everything else flat and typed) already
-- favors flat parameters over forcing symmetry with the TypeScript
-- shape. p_voting_source_type is the flat discriminator; p_voting_candidates
-- (jsonb array of strings) and p_voting_source_interaction_instance_id
-- are its two mutually-exclusive payloads.
--
--   p_prepared_question_id supplied        -> existing MULTIPLE_CHOICE path, unchanged
--   p_voting_source_type = 'HOST_AUTHORED' -> VOTING, candidates from p_voting_candidates
--   p_voting_source_type = 'SUBMISSION'    -> VOTING, candidates resolved from
--                                              p_voting_source_interaction_instance_id's
--                                              submissions
--   neither supplied                       -> existing OPEN_RESPONSE path, unchanged
--
-- Unlike the MULTIPLE_CHOICE path, p_prompt_text IS required for both
-- Voting sub-cases — neither candidate source provides host-framing
-- text ("Vote for your favorite!"), so this function re-enforces the
-- same EMPTY_PROMPT_TEXT check the default Open Response path already
-- uses, rather than silently accepting empty framing text the way the
-- prepared-question path silently ignores p_prompt_text entirely.
--
-- Signature change (4 args -> 7): requires the drop-then-create
-- pattern established in 0017-0020 and reused in 0022 and 0026 —
-- Postgres does not treat this as a safe CREATE OR REPLACE target.
-- Return shape (interaction_instance_id, prompt_id, state, engine_type)
-- is unchanged from 0026.
--
-- Candidate Resolution's SUBMISSION path re-verifies, inside this same
-- atomic operation, that the named source interaction belongs to this
-- session, is engine_type OPEN_RESPONSE, is state RESULT_REVEAL, and
-- has at least one submission — then copies each submission's text
-- into a new, Voting-owned voting_candidates row. The source
-- interaction instance itself is never written to. Candidates are
-- ordinal-ordered by submission created_at for a stable, deterministic
-- presentation order.

drop function if exists start_session_atomically(uuid, text, text, uuid);

create function start_session_atomically(
  p_session_id uuid,
  p_host_token text,
  p_prompt_text text default null,
  p_prepared_question_id uuid default null,
  p_voting_source_type text default null,
  p_voting_candidates jsonb default null,
  p_voting_source_interaction_instance_id uuid default null
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
  v_source_session_id uuid;
  v_source_engine_type text;
  v_source_state text;
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

  -- Slice 007: reject an ambiguous request outright rather than
  -- silently letting p_prepared_question_id win — mirrors the domain
  -- layer's own identical, authoritative-re-check discipline.
  if p_prepared_question_id is not null and p_voting_source_type is not null then
    raise exception 'AMBIGUOUS_START_TARGET: at most one of preparedQuestionId or votingCandidateSource may be supplied'
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
  elsif p_voting_source_type is not null then
    if btrim(coalesce(p_prompt_text, '')) = '' then
      raise exception 'EMPTY_PROMPT_TEXT: prompt text cannot be empty'
        using errcode = 'P0001';
    end if;

    insert into prompts (text)
    values (btrim(p_prompt_text))
    returning prompts.prompt_id into v_prompt_id;

    insert into interaction_instances (session_id, prompt_id, state, engine_type)
    values (p_session_id, v_prompt_id, 'PROMPT_ACTIVE', 'VOTING')
    returning interaction_instances.interaction_instance_id into v_interaction_instance_id;

    if p_voting_source_type = 'HOST_AUTHORED' then
      if p_voting_candidates is null
         or jsonb_typeof(p_voting_candidates) <> 'array'
         or jsonb_array_length(p_voting_candidates) < 2 then
        raise exception 'INVALID_VOTING_CANDIDATES: at least two candidates are required'
          using errcode = 'P0001';
      end if;

      if exists (
        select 1 from jsonb_array_elements_text(p_voting_candidates) as c(val)
        where btrim(c.val) = ''
      ) then
        raise exception 'INVALID_VOTING_CANDIDATES: candidates must not be empty'
          using errcode = 'P0001';
      end if;

      if (
        select count(distinct btrim(c.val))
        from jsonb_array_elements_text(p_voting_candidates) as c(val)
      ) <> jsonb_array_length(p_voting_candidates) then
        raise exception 'INVALID_VOTING_CANDIDATES: candidates must be distinct'
          using errcode = 'P0001';
      end if;

      insert into voting_candidates (interaction_instance_id, ordinal, label)
      select v_interaction_instance_id, t.ord - 1, btrim(t.val)
      from jsonb_array_elements_text(p_voting_candidates) with ordinality as t(val, ord);

    elsif p_voting_source_type = 'SUBMISSION' then
      select interaction_instances.session_id, interaction_instances.engine_type,
             interaction_instances.state
        into v_source_session_id, v_source_engine_type, v_source_state
      from interaction_instances
      where interaction_instances.interaction_instance_id = p_voting_source_interaction_instance_id;

      if v_source_session_id is null or v_source_session_id <> p_session_id then
        raise exception 'VOTING_SOURCE_INTERACTION_NOT_FOUND: no interaction exists for this id in this session'
          using errcode = 'P0001';
      end if;

      if v_source_engine_type <> 'OPEN_RESPONSE' or v_source_state <> 'RESULT_REVEAL' then
        raise exception 'VOTING_SOURCE_INTERACTION_NOT_ELIGIBLE: source interaction is not an eligible OPEN_RESPONSE interaction at RESULT_REVEAL'
          using errcode = 'P0001';
      end if;

      if not exists (
        select 1 from submissions
        where submissions.interaction_instance_id = p_voting_source_interaction_instance_id
      ) then
        raise exception 'VOTING_SOURCE_INTERACTION_NOT_ELIGIBLE: source interaction has no submissions'
          using errcode = 'P0001';
      end if;

      insert into voting_candidates (interaction_instance_id, ordinal, label)
      select
        v_interaction_instance_id,
        row_number() over (order by submissions.created_at) - 1,
        submissions.text
      from submissions
      where submissions.interaction_instance_id = p_voting_source_interaction_instance_id;

    else
      raise exception 'INVALID_VOTING_CANDIDATES: unrecognized voting candidate source type'
        using errcode = 'P0001';
    end if;

    v_engine_type := 'VOTING';
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
      'engineType', v_engine_type,
      'votingCandidateSourceType', p_voting_source_type,
      'votingSourceInteractionInstanceId', p_voting_source_interaction_instance_id
    )
  );

  return query select v_interaction_instance_id, v_prompt_id, 'PROMPT_ACTIVE'::text, v_engine_type;
end;
$$;
