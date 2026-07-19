-- Migration: 0002_create_session_atomically
-- Purpose:
-- Persist a newly created session and its initial SESSION_CREATED event
-- as one atomic database operation.
--
-- Transactional guarantee:
-- If either insert fails, PostgreSQL rolls back the entire function call.

create or replace function create_session_atomically(
  p_session_id uuid,
  p_room_code text,
  p_host_token text,
  p_state text,
  p_state_version integer,
  p_pause_reason text,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_event_type text,
  p_event_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into sessions (
    session_id,
    room_code,
    host_token,
    state,
    state_version,
    pause_reason,
    created_at,
    updated_at
  )
  values (
    p_session_id,
    p_room_code,
    p_host_token,
    p_state,
    p_state_version,
    p_pause_reason,
    p_created_at,
    p_updated_at
  );

  insert into session_events (
    session_id,
    event_type,
    payload
  )
  values (
    p_session_id,
    p_event_type,
    p_event_payload
  );
end;
$$;