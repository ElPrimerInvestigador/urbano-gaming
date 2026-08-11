-- Migration: 0034_cast_vote_atomically
-- Slice 007 — Voting Engine (Proving Case).
--
-- CAST_VOTE's atomic operation, mirroring
-- submit_response_atomically_interaction_scoped (0017) closely: same
-- participant-token re-check, same row-locked current-interaction
-- resolution, same upsert-for-revision-before-close shape. Two
-- differences from that precedent:
--
-- - the current interaction must additionally be engine_type 'VOTING'
--   (PROMPT_NOT_ACTIVE covers this too — a Voting-only command finding
--   a non-Voting current interaction is "not currently accepting
--   this kind of input," the same rejection shape as no interaction
--   being PROMPT_ACTIVE at all, not a new error class);
-- - candidate_id must be re-verified as belonging to this specific
--   interaction instance's voting_candidates before the upsert, the
--   Voting analogue of validate_option_selection's index-bounds check
--   in the TypeScript domain layer, enforced here authoritatively via
--   a real foreign key plus this explicit ownership check (a bare FK
--   alone would accept a candidate_id that exists but belongs to a
--   *different* interaction instance).
--
-- votes_interaction_instance_participant_unique (0032) is the upsert's
-- ON CONFLICT target, referenced by column list exactly as 0017
-- references submissions' equivalent index.

create function cast_vote_atomically(
  p_session_id uuid,
  p_participant_id uuid,
  p_participant_token text,
  p_candidate_id uuid
)
returns table (
  vote_id uuid,
  interaction_instance_id uuid,
  candidate_id uuid,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_state text;
  v_participant_match uuid;
  v_interaction_instance_id uuid;
  v_interaction_state text;
  v_engine_type text;
  v_candidate_match uuid;
  v_vote_id uuid;
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

  select interaction_instances.interaction_instance_id, interaction_instances.state,
         interaction_instances.engine_type
    into v_interaction_instance_id, v_interaction_state, v_engine_type
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1
  for update;

  if v_session_state <> 'LOBBY_LOCKED'
     or v_interaction_instance_id is null
     or v_interaction_state <> 'PROMPT_ACTIVE'
     or v_engine_type <> 'VOTING' then
    raise exception 'PROMPT_NOT_ACTIVE: no Voting interaction is currently PROMPT_ACTIVE for this session'
      using errcode = 'P0001';
  end if;

  select voting_candidates.candidate_id into v_candidate_match
  from voting_candidates
  where voting_candidates.candidate_id = p_candidate_id
    and voting_candidates.interaction_instance_id = v_interaction_instance_id;

  if v_candidate_match is null then
    raise exception 'INVALID_CANDIDATE_SELECTION: selected candidate is not valid for this Voting interaction'
      using errcode = 'P0001';
  end if;

  insert into votes (interaction_instance_id, participant_id, candidate_id)
  values (v_interaction_instance_id, p_participant_id, p_candidate_id)
  on conflict (interaction_instance_id, participant_id)
  do update set candidate_id = excluded.candidate_id, updated_at = now()
  returning votes.vote_id, votes.updated_at
  into v_vote_id, v_updated_at;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'VOTE_CAST',
    jsonb_build_object(
      'participantId', p_participant_id,
      'interactionInstanceId', v_interaction_instance_id,
      'candidateId', p_candidate_id
    )
  );

  return query select v_vote_id, v_interaction_instance_id, p_candidate_id, v_updated_at;
end;
$$;
