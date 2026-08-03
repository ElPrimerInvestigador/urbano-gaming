-- Migration: 0027_reveal_results_atomically_evaluates_multiple_choice
-- Slice 003 — Second Interaction Engine (Multiple Choice Trivia).
--
-- REVEAL_RESULTS gains automatic scoring for Multiple Choice
-- interactions, performed inside the exact same transaction as the
-- RESULT_REVEAL state transition, not as a series of separate calls
-- afterward. This was an explicit design requirement: if evaluation
-- were a sequence of independent AWARD_POINTS calls issued after
-- reveal already committed, a failure partway through could leave the
-- interaction revealed with some participants scored and others not,
-- and a naive retry of REVEAL_RESULTS would no longer run at all,
-- since the interaction is no longer SUBMISSIONS_CLOSED.
--
-- Doing it inside one transaction eliminates that failure mode by
-- construction rather than mitigating it: either the state transition
-- and every correct participant's point award all commit together, or
-- none of them do and the interaction remains SUBMISSIONS_CLOSED,
-- safe to retry from a clean slate. This is a stronger guarantee than
-- a separately-callable, independently-idempotent evaluation step
-- would have provided, and it required no new atomic function — only
-- an additional step inside this one, reusing point_awards exactly as
-- Slice 002 built it.
--
-- point_awards.idempotency_key is a uuid column (0021). Automatic
-- awards need a key that is deterministic (so re-evaluating the same
-- interaction, e.g. if this function were ever invoked twice, cannot
-- double-award) but the natural deterministic input — a composite of
-- interactionInstanceId and participantId — is not itself a uuid.
-- md5() of that composite string produces a 32-character hex digest,
-- which Postgres's uuid input parser accepts directly (hyphens are
-- optional in uuid literals) — so casting it to uuid yields a valid,
-- deterministic, collision-resistant key without requiring the
-- uuid-ossp extension. This does not change point_awards' idempotency
-- *model* (still unique(session_id, idempotency_key), still
-- append-only) — it only changes how one producer (automatic engine
-- evaluation, as opposed to a host's client-generated random key)
-- computes its own key value.
--
-- Signature and RETURNS TABLE shape are both unchanged from 0019, so
-- CREATE OR REPLACE is safe here — this is not the shape-change bug
-- class fixed in 0017-0020 and 0026; only the function body grows.

create or replace function reveal_results_atomically(
  p_session_id uuid,
  p_host_token text,
  p_event_type text,
  p_event_payload jsonb
)
returns table (interaction_instance_id uuid, state text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_state text;
  v_host_token text;
  v_interaction_instance_id uuid;
  v_interaction_state text;
  v_engine_type text;
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

  select interaction_instances.interaction_instance_id, interaction_instances.state
    into v_interaction_instance_id, v_interaction_state
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1
  for update;

  if v_session_state <> 'LOBBY_LOCKED'
     or v_interaction_instance_id is null
     or v_interaction_state <> 'SUBMISSIONS_CLOSED' then
    raise exception 'SUBMISSIONS_NOT_CLOSED: no interaction is currently SUBMISSIONS_CLOSED for this session'
      using errcode = 'P0001';
  end if;

  update interaction_instances
  set state = 'RESULT_REVEAL',
      updated_at = now()
  where interaction_instances.interaction_instance_id = v_interaction_instance_id;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    p_event_type,
    p_event_payload || jsonb_build_object('interactionInstanceId', v_interaction_instance_id)
  );

  select interaction_instances.engine_type into v_engine_type
  from interaction_instances
  where interaction_instances.interaction_instance_id = v_interaction_instance_id;

  if v_engine_type = 'MULTIPLE_CHOICE' then
    insert into point_awards (
      session_id, interaction_instance_id, participant_id, points, idempotency_key
    )
    select
      p_session_id,
      v_interaction_instance_id,
      submissions.participant_id,
      mcd.points_for_correct,
      md5('mc-auto:' || v_interaction_instance_id::text || ':' || submissions.participant_id::text)::uuid
    from submissions
    join multiple_choice_details mcd
      on mcd.interaction_instance_id = v_interaction_instance_id
    where submissions.interaction_instance_id = v_interaction_instance_id
      and submissions.text = mcd.correct_option_index::text
    on conflict (session_id, idempotency_key) do nothing;
  end if;

  return query select v_interaction_instance_id, 'RESULT_REVEAL'::text;
end;
$$;
