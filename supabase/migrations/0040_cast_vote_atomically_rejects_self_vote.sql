-- Migration: 0040_cast_vote_atomically_rejects_self_vote
-- Slice 009 — Engine Selection + PARTICIPANTS Voting.
--
-- Extends cast_vote_atomically's existing candidate-ownership check
-- (0034: is this candidate_id valid for this interaction instance?) to
-- also fetch voting_candidates.participant_id (0038) and reject the
-- vote when it equals the voting participant's own p_participant_id —
-- this function's own authoritative, founder-required self-vote
-- prohibition. A participant cannot vote for their own Candidate.
--
-- Mirrors, and is authoritative over, the domain-layer fast-path check
-- added to castVote.ts in this same slice — this is the real
-- enforcement; that fast-path is only an early, cheap rejection ahead
-- of this same re-check inside the same atomic operation that performs
-- the upsert, the same "fast-path is not the sole guarantee" discipline
-- every other command in this schema already follows.
--
-- No-op for HOST_AUTHORED Candidates: participant_id is always null for
-- those (0039), so the equality check can never match regardless of
-- which participant is voting.
--
-- Signature is UNCHANGED from 0034 (still 4 parameters) — CREATE OR
-- REPLACE FUNCTION is used rather than the drop-then-create pattern
-- other signature-changing migrations in this schema required.

create or replace function cast_vote_atomically(
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
  v_candidate_participant_id uuid;
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

  select voting_candidates.candidate_id, voting_candidates.participant_id
    into v_candidate_match, v_candidate_participant_id
  from voting_candidates
  where voting_candidates.candidate_id = p_candidate_id
    and voting_candidates.interaction_instance_id = v_interaction_instance_id;

  if v_candidate_match is null then
    raise exception 'INVALID_CANDIDATE_SELECTION: selected candidate is not valid for this Voting interaction'
      using errcode = 'P0001';
  end if;

  -- Slice 009: authoritative self-vote prohibition. No-op when
  -- v_candidate_participant_id is null (HOST_AUTHORED Candidates), since
  -- null <> p_participant_id and null = p_participant_id are both never
  -- true in SQL's three-valued logic.
  if v_candidate_participant_id = p_participant_id then
    raise exception 'SELF_VOTE_NOT_ALLOWED: a participant cannot vote for their own candidate'
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
