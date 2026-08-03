-- Migration: 0022_award_points_atomically
-- Slice 002 — Scored Multi-Round Experience.
--
-- AWARD_POINTS: the host awards a specific participant a positive
-- number of points for a specific, currently-revealed Interaction
-- Instance, idempotently.
--
-- Idempotency-first sequence (accepted design, both clarification
-- rounds incorporated):
--
--   1. Look up an existing point_award by (session_id, idempotency_key).
--      If found, return it immediately — no host, session-state,
--      interaction-eligibility, participant-membership, or points
--      validation runs at all. This is what lets a network retry
--      succeed identically even after the Session has moved on to a
--      later interaction or completed: the replay is resolved purely
--      by the key, never by re-evaluating current runtime state.
--   2. Only when the key is genuinely new does full validation run:
--      host token match, session LOBBY_LOCKED, the supplied
--      interaction_instance_id is both the session's current
--      (most-recently-created) interaction AND at RESULT_REVEAL,
--      participant belongs to the session, points is a positive
--      integer within a sane bound.
--   3. Insert, guarding with ON CONFLICT (session_id, idempotency_key)
--      DO NOTHING against a concurrent request racing with this one
--      using the same key — if this insert loses that race, fetch and
--      return the winner's row rather than erroring.
--
-- The explicit interaction_instance_id parameter (rather than always
-- resolving "whatever is current now," the way startSession/
-- submitResponse/closeSubmissions/revealResults do) exists so a
-- request carries an unambiguous target from the moment it's created,
-- independent of how much the Session has progressed by the time a
-- retry is actually processed.
--
-- Column-list ambiguity: this function's INSERT column list, its
-- ON CONFLICT target, and its lookup SELECTs all reference
-- point_award_id / interaction_instance_id / participant_id / points /
-- created_at, which collide with this function's own RETURNS TABLE
-- output parameter names — the same bug class fixed in 0014 and
-- 0017-0019. #variable_conflict use_column resolves it the same way,
-- for the same reason.

create function award_points_atomically(
  p_session_id uuid,
  p_host_token text,
  p_interaction_instance_id uuid,
  p_participant_id uuid,
  p_points integer,
  p_idempotency_key uuid
)
returns table (
  point_award_id uuid,
  interaction_instance_id uuid,
  participant_id uuid,
  points integer,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_existing_id uuid;
  v_existing_interaction_instance_id uuid;
  v_existing_participant_id uuid;
  v_existing_points integer;
  v_existing_created_at timestamptz;
  v_session_state text;
  v_host_token text;
  v_current_interaction_id uuid;
  v_current_interaction_state text;
  v_participant_match uuid;
  v_new_id uuid;
  v_new_created_at timestamptz;
begin
  -- Step 1: idempotency-first resolution, scoped to this session.
  select point_awards.point_award_id,
         point_awards.interaction_instance_id,
         point_awards.participant_id,
         point_awards.points,
         point_awards.created_at
    into v_existing_id, v_existing_interaction_instance_id,
         v_existing_participant_id, v_existing_points, v_existing_created_at
  from point_awards
  where point_awards.session_id = p_session_id
    and point_awards.idempotency_key = p_idempotency_key;

  if v_existing_id is not null then
    return query select v_existing_id, v_existing_interaction_instance_id,
                        v_existing_participant_id, v_existing_points,
                        v_existing_created_at;
    return;
  end if;

  -- Step 2: new-award path — full validation, reached only when the
  -- idempotency key is genuinely new for this session.
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
    into v_current_interaction_id, v_current_interaction_state
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1
  for update;

  if v_current_interaction_id is null
     or v_current_interaction_id <> p_interaction_instance_id
     or v_current_interaction_state <> 'RESULT_REVEAL' then
    raise exception 'INTERACTION_NOT_ELIGIBLE: the supplied interaction is not the session''s current, revealed interaction'
      using errcode = 'P0001';
  end if;

  select participants.participant_id into v_participant_match
  from participants
  where participants.participant_id = p_participant_id
    and participants.session_id = p_session_id;

  if v_participant_match is null then
    raise exception 'PARTICIPANT_NOT_IN_SESSION: this participant does not belong to this session'
      using errcode = 'P0001';
  end if;

  if p_points <= 0 or p_points > 10000 then
    raise exception 'INVALID_POINTS: points must be a positive integer no greater than 10000'
      using errcode = 'P0001';
  end if;

  -- Step 3: insert, guarding against a concurrent identical request
  -- racing between the lookup above and this insert.
  insert into point_awards (
    session_id, interaction_instance_id, participant_id, points, idempotency_key
  )
  values (
    p_session_id, p_interaction_instance_id, p_participant_id, p_points, p_idempotency_key
  )
  on conflict (session_id, idempotency_key) do nothing
  returning point_awards.point_award_id, point_awards.created_at
  into v_new_id, v_new_created_at;

  if v_new_id is null then
    -- Lost the race: a concurrent request with the same session_id and
    -- idempotency_key committed first. Fetch and return its result
    -- instead of erroring — this request is a legitimate duplicate of
    -- one that just succeeded, not a conflict to reject.
    select point_awards.point_award_id, point_awards.created_at
      into v_new_id, v_new_created_at
    from point_awards
    where point_awards.session_id = p_session_id
      and point_awards.idempotency_key = p_idempotency_key;

    return query select v_new_id, p_interaction_instance_id, p_participant_id,
                        p_points, v_new_created_at;
    return;
  end if;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'POINTS_AWARDED',
    jsonb_build_object(
      'pointAwardId', v_new_id,
      'interactionInstanceId', p_interaction_instance_id,
      'participantId', p_participant_id,
      'points', p_points
    )
  );

  return query select v_new_id, p_interaction_instance_id, p_participant_id,
                      p_points, v_new_created_at;
end;
$$;
