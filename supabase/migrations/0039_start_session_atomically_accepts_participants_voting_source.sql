-- Migration: 0039_start_session_atomically_accepts_participants_voting_source
-- Slice 009 — Engine Selection + PARTICIPANTS Voting.
--
-- Two changes to start_session_atomically, both scoped to the existing
-- p_voting_source_type = 'VOTING' branch:
--
--   1. p_voting_source_type = 'PARTICIPANTS' becomes a third accepted
--      value, alongside 'HOST_AUTHORED' and 'SUBMISSION'. Needs no new
--      SQL parameter — the session's own current roster (already
--      resolvable from p_session_id, which this function already holds
--      a row lock on) is the entire source. Candidates are snapshotted
--      from participants ordered by joined_at, the same "stable,
--      deterministic presentation order" precedent SUBMISSION already
--      established (submissions ordered by created_at). Subject to the
--      same >= 2 candidate floor INVALID_VOTING_CANDIDATES already
--      enforces for HOST_AUTHORED — a Voting round is equally unusable
--      with fewer than two Candidates regardless of source.
--
--   2. voting_candidates.participant_id (0038) is now populated on
--      every insert into that table, for every source:
--        HOST_AUTHORED -> null (no participant produced this Candidate)
--        SUBMISSION    -> that submission's own participant_id (already
--                          required and non-null, 0009)
--        PARTICIPANTS  -> that participant's own participant_id (the
--                          participant IS the candidate)
--
-- Signature is UNCHANGED from 0037 (still 8 parameters, same names,
-- types, and defaults) — CREATE OR REPLACE FUNCTION is used rather than
-- the drop-then-create pattern 0017-0020/0022/0026/0033/0037 required,
-- since none of those migrations' actual blocker (a signature change)
-- applies here.
--
-- Self-vote enforcement (0040, cast_vote_atomically) depends on this
-- migration having already populated participant_id correctly — it is
-- what that function compares the voting participant's own id against.

create or replace function start_session_atomically(
  p_session_id uuid,
  p_host_token text,
  p_prompt_text text default null,
  p_prepared_question_id uuid default null,
  p_voting_source_type text default null,
  p_voting_candidates jsonb default null,
  p_voting_source_interaction_instance_id uuid default null,
  p_segment_target text default 'NEW_SEGMENT'
)
returns table (
  interaction_instance_id uuid,
  prompt_id uuid,
  state text,
  engine_type text,
  segment_ordinal integer
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
  v_previous_segment_id uuid;
  v_segment_id uuid;
  v_segment_ordinal integer;
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
  v_participant_count integer;
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

  select interaction_instances.interaction_instance_id, interaction_instances.state,
         interaction_instances.segment_id
    into v_previous_interaction_instance_id, v_previous_interaction_state,
         v_previous_segment_id
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

  -- Slice 008: resolve which Segment the new Interaction Instance
  -- joins. Executes after the session-row lock above is already held —
  -- see 0037's header comment for why that makes the MAX+1 allocation
  -- below safe.
  if p_segment_target = 'CURRENT_SEGMENT' then
    if v_previous_segment_id is null then
      raise exception 'NO_CURRENT_SEGMENT_TO_CONTINUE: no current Segment exists for this session'
        using errcode = 'P0001';
    end if;

    v_segment_id := v_previous_segment_id;

    select segments.segment_ordinal into v_segment_ordinal
    from segments
    where segments.segment_id = v_segment_id;
  else
    select coalesce(max(segments.segment_ordinal), 0) + 1 into v_segment_ordinal
    from segments
    where segments.session_id = p_session_id;

    insert into segments (session_id, segment_ordinal)
    values (p_session_id, v_segment_ordinal)
    returning segments.segment_id into v_segment_id;
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

    insert into interaction_instances (session_id, segment_id, prompt_id, state, engine_type)
    values (p_session_id, v_segment_id, v_prompt_id, 'PROMPT_ACTIVE', 'MULTIPLE_CHOICE')
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

    insert into interaction_instances (session_id, segment_id, prompt_id, state, engine_type)
    values (p_session_id, v_segment_id, v_prompt_id, 'PROMPT_ACTIVE', 'VOTING')
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

      insert into voting_candidates (interaction_instance_id, ordinal, label, participant_id)
      select v_interaction_instance_id, t.ord - 1, btrim(t.val), null
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

      insert into voting_candidates (interaction_instance_id, ordinal, label, participant_id)
      select
        v_interaction_instance_id,
        row_number() over (order by submissions.created_at) - 1,
        submissions.text,
        submissions.participant_id
      from submissions
      where submissions.interaction_instance_id = p_voting_source_interaction_instance_id;

    elsif p_voting_source_type = 'PARTICIPANTS' then
      -- Slice 009: snapshot the session's current roster. Same >= 2
      -- floor as HOST_AUTHORED — a Voting round is equally unusable
      -- with fewer than two Candidates regardless of source. No
      -- eligibility precondition beyond that: unlike SUBMISSION, this
      -- source depends on no prior interaction at all.
      select count(*) into v_participant_count
      from participants
      where participants.session_id = p_session_id;

      if v_participant_count < 2 then
        raise exception 'INVALID_VOTING_CANDIDATES: at least two candidates are required'
          using errcode = 'P0001';
      end if;

      insert into voting_candidates (interaction_instance_id, ordinal, label, participant_id)
      select
        v_interaction_instance_id,
        row_number() over (order by participants.joined_at) - 1,
        participants.display_name,
        participants.participant_id
      from participants
      where participants.session_id = p_session_id;

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

    insert into interaction_instances (session_id, segment_id, prompt_id, state, engine_type)
    values (p_session_id, v_segment_id, v_prompt_id, 'PROMPT_ACTIVE', 'OPEN_RESPONSE')
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
      'segmentId', v_segment_id,
      'segmentTarget', p_segment_target,
      'votingCandidateSourceType', p_voting_source_type,
      'votingSourceInteractionInstanceId', p_voting_source_interaction_instance_id
    )
  );

  return query select v_interaction_instance_id, v_prompt_id, 'PROMPT_ACTIVE'::text,
    v_engine_type, v_segment_ordinal;
end;
$$;
