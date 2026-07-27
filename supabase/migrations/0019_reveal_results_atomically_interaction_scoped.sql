-- Migration: 0019_reveal_results_atomically_interaction_scoped
-- Slice 001 — Session / Interaction separation.
--
-- Re-scopes REVEAL_RESULTS from the session's own state to the
-- session's current interaction instance, mirroring 0018 exactly.
-- Session state must be LOBBY_LOCKED and the current interaction
-- instance must be SUBMISSIONS_CLOSED.
--
-- Return-shape change: same caveat as 0018 — RETURNS TABLE changes
-- from (state text, state_version integer) to (interaction_instance_id
-- uuid, state text), which Postgres refuses to CREATE OR REPLACE
-- across (see 0017's comment). The prior 4-argument version is
-- dropped explicitly, then the same-arity, new-return-shape version
-- created.

drop function if exists reveal_results_atomically(uuid, text, text, jsonb);

create function reveal_results_atomically(
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

  return query select v_interaction_instance_id, 'RESULT_REVEAL'::text;
end;
$$;
