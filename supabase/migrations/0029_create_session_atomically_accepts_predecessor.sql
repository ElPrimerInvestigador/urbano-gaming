-- Migration: 0029_create_session_atomically_accepts_predecessor
-- Session Continuity slice.
--
-- Extends create_session_atomically with an optional, defaulted
-- p_predecessor_session_id parameter, mirroring 0026's precedent of
-- widening an existing atomic function with a new optional argument
-- rather than introducing a parallel one. Unlike 0026, this change
-- neither alters the return shape nor removes an existing parameter,
-- so plain CREATE OR REPLACE applies — no drop-then-create needed.
--
-- No new validation lives in this function. Unlike lock_lobby_atomically
-- or start_session_atomically, there is no concurrent state to
-- re-verify here: the predecessor session (if any) is only ever read,
-- never written, by this call, and its being SESSION_COMPLETE with a
-- matching host token was already authoritatively confirmed by the
-- caller (createSuccessorSession) before this function is invoked —
-- confirmed once and permanently true, since nothing in this schema
-- ever mutates a session already at SESSION_COMPLETE. The only
-- genuine race this migration must handle is two concurrent calls
-- naming the same predecessor, and that is caught by
-- sessions_predecessor_session_id_unique (0028) exactly the way
-- sessions_room_code_active_unique already guards room code
-- collisions in this same function.

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
  p_event_payload jsonb,
  p_predecessor_session_id uuid default null
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
    updated_at,
    predecessor_session_id
  )
  values (
    p_session_id,
    p_room_code,
    p_host_token,
    p_state,
    p_state_version,
    p_pause_reason,
    p_created_at,
    p_updated_at,
    p_predecessor_session_id
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
