-- Migration: 0006_complete_session_atomically
-- Purpose:
-- Authenticate the host via the stored host token, atomically re-verify
-- the session is not already SESSION_COMPLETE, and transition it to
-- SESSION_COMPLETE, incrementing state_version and persisting a
-- SESSION_COMPLETED event — all as one atomic operation. Mirrors
-- lock_lobby_atomically's row-locked re-check (0005 migration).
--
-- Interpretation 2 (administrative termination): callable from any
-- state except SESSION_COMPLETE itself. Unlike lock_lobby_atomically,
-- which requires exactly LOBBY_OPEN, this function's guard is an
-- inequality (state <> 'SESSION_COMPLETE'), not an equality — there is
-- no single required source state.
--
-- Transactional guarantee:
-- If any step fails, PostgreSQL rolls back the entire function call.
--
-- Host-token and session-state authority:
-- Both the supplied host token and the session's current state are
-- re-verified inside this function, under a row lock
-- (SELECT ... FOR UPDATE), immediately before the transition is
-- applied — consistent with lock_lobby_atomically's reasoning.
--
-- A session that no longer exists, has a mismatched host token, or is
-- already SESSION_COMPLETE at the moment of this check raises a
-- distinct, named exception (SESSION_NOT_FOUND / HOST_TOKEN_MISMATCH /
-- SESSION_ALREADY_COMPLETE) rather than being inferred from a generic
-- error. The calling adapter translates these explicitly.
--
-- Room-code reuse: this is the first real production path that can
-- ever produce SESSION_COMPLETE. sessions_room_code_active_unique
-- (0001 migration) has been scoped to exclude SESSION_COMPLETE sessions
-- since the very first migration, but until this function existed,
-- that exclusion was only reachable via a test-only backdoor
-- (_forceComplete) — never through real application code.

create or replace function complete_session_atomically(
  p_session_id uuid,
  p_host_token text,
  p_event_type text,
  p_event_payload jsonb
)
returns table (state text, state_version integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
  v_state_version integer;
  v_host_token text;
begin
  select state, state_version, host_token
    into v_state, v_state_version, v_host_token
  from sessions
  where session_id = p_session_id
  for update;

  if v_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if v_state = 'SESSION_COMPLETE' then
    raise exception 'SESSION_ALREADY_COMPLETE: session is already complete'
      using errcode = 'P0001';
  end if;

  update sessions
  set state = 'SESSION_COMPLETE',
      state_version = state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

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

  return query select 'SESSION_COMPLETE'::text, v_state_version + 1;
end;
$$;
