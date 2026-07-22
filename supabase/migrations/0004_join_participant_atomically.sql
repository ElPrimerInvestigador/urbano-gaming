-- Migration: 0004_join_participant_atomically
-- Purpose:
-- Persist a newly joined participant and its PARTICIPANT_JOINED event
-- as one atomic database operation, mirroring
-- 0002_create_session_atomically's structure for the sessions aggregate.
--
-- Transactional guarantee:
-- If either insert fails, PostgreSQL rolls back the entire function call.
--
-- Session-state authority:
-- The session's state is re-verified inside this function, under a row
-- lock (SELECT ... FOR UPDATE), immediately before the participant is
-- inserted. This closes the race window between an application-layer
-- lookup (e.g. getActiveSessionByRoomCode) and this write — a concurrent
-- LOCK_LOBBY, PAUSE, or COMPLETE transition on the same session_id
-- cannot race past this check, because the row lock serializes against
-- any other transaction that also locks or updates that row.
--
-- A session that no longer exists, or is no longer LOBBY_OPEN at the
-- moment of this check, raises a distinct, named exception
-- (SESSION_NOT_FOUND / SESSION_NOT_JOINABLE) rather than being inferred
-- from a generic error. The calling adapter translates these explicitly.
--
-- Note: session-scoped normalized display-name uniqueness (enforced by
-- participants_session_display_name_unique from 0003) provides duplicate
-- -name enforcement, not command-level idempotency. A repeated call with
-- the same normalized_display_name for the same session_id fails with a
-- unique_violation rather than returning the original participant. This
-- is deliberate MVP behavior, not a defect of this function.

create or replace function join_participant_atomically(
  p_participant_id uuid,
  p_session_id uuid,
  p_display_name text,
  p_normalized_display_name text,
  p_participant_token text,
  p_joined_at timestamptz,
  p_event_type text,
  p_event_payload jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
begin
  -- Row lock on the target session: blocks concurrently with any other
  -- transaction that also SELECT ... FOR UPDATEs or UPDATEs this same
  -- session_id (e.g. a future LOCK_LOBBY/PAUSE_SESSION command), so the
  -- state read below cannot be stale by the time this function commits.
  select state into v_state
  from sessions
  where session_id = p_session_id
  for update;

  if v_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_state <> 'LOBBY_OPEN' then
    raise exception 'SESSION_NOT_JOINABLE: session is in % state, not LOBBY_OPEN', v_state
      using errcode = 'P0001';
  end if;

  insert into participants (
    participant_id,
    session_id,
    display_name,
    normalized_display_name,
    participant_token,
    joined_at
  )
  values (
    p_participant_id,
    p_session_id,
    p_display_name,
    p_normalized_display_name,
    p_participant_token,
    p_joined_at
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

-- Display-name floor, enforced at the schema level as a backstop to the
-- application-layer validation in joinSession.ts. Applied here (0004)
-- rather than editing 0003 directly, since 0003 is treated as frozen.
-- Rule: at least 1 visible character and at most 40 characters, both
-- measured after trimming leading/trailing whitespace.
alter table participants
  add constraint display_name_length_check
  check (
    char_length(btrim(display_name)) >= 1
    and char_length(btrim(display_name)) <= 40
  );
