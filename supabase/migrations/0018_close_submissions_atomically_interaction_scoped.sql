-- Migration: 0018_close_submissions_atomically_interaction_scoped
-- Slice 001 — Session / Interaction separation.
--
-- Re-scopes CLOSE_SUBMISSIONS from the session's own state to the
-- session's current interaction instance. Same route, same request
-- shape; the response now describes the interaction instance that
-- closed, not the session.
--
-- Session state must be LOBBY_LOCKED and the current interaction
-- instance (row-locked, resolved the same way as 0017) must be
-- PROMPT_ACTIVE.
--
-- Return-shape change: this function's RETURNS TABLE changes from
-- (state text, state_version integer) to (interaction_instance_id
-- uuid, state text) — a different output row type, which Postgres
-- refuses to CREATE OR REPLACE across (see 0017's comment for the
-- full explanation). The prior 4-argument version is dropped
-- explicitly, then the same-arity, new-return-shape version created.

drop function if exists close_submissions_atomically(uuid, text, text, jsonb);

create function close_submissions_atomically(
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
     or v_interaction_state <> 'PROMPT_ACTIVE' then
    raise exception 'PROMPT_NOT_ACTIVE: no interaction is currently PROMPT_ACTIVE for this session'
      using errcode = 'P0001';
  end if;

  update interaction_instances
  set state = 'SUBMISSIONS_CLOSED',
      updated_at = now()
  where interaction_instances.interaction_instance_id = v_interaction_instance_id;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    p_event_type,
    p_event_payload || jsonb_build_object('interactionInstanceId', v_interaction_instance_id)
  );

  return query select v_interaction_instance_id, 'SUBMISSIONS_CLOSED'::text;
end;
$$;
