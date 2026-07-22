-- Migration: 0005_lock_lobby_atomically
-- Purpose:
-- Authenticate the host via the stored host token, atomically re-verify
-- the session is LOBBY_OPEN, and transition it to LOBBY_LOCKED,
-- incrementing state_version and persisting a LOBBY_LOCKED event — all
-- as one atomic operation. Mirrors join_participant_atomically's
-- row-locked re-check (0004 migration), applied to the sessions
-- aggregate itself rather than to a child entity.
--
-- Transactional guarantee:
-- If any step fails, PostgreSQL rolls back the entire function call.
--
-- Host-token and session-state authority:
-- Both the supplied host token and the session's current state are
-- re-verified inside this function, under a row lock
-- (SELECT ... FOR UPDATE), immediately before the transition is
-- applied. This closes the race window between an application-layer
-- lookup (e.g. getSessionById) and this write, and — since host_token
-- is a security-bearing credential (see hostToken.ts) — ensures the
-- authorization check itself is never trusted solely from an earlier,
-- non-authoritative caller-side check.
--
-- A session that no longer exists, has a mismatched host token, or is
-- no longer LOBBY_OPEN at the moment of this check raises a distinct,
-- named exception (SESSION_NOT_FOUND / HOST_TOKEN_MISMATCH /
-- LOBBY_NOT_OPEN) rather than being inferred from a generic error. The
-- calling adapter translates these explicitly.

create or replace function lock_lobby_atomically(
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

  if v_state <> 'LOBBY_OPEN' then
    raise exception 'LOBBY_NOT_OPEN: session is in % state, not LOBBY_OPEN', v_state
      using errcode = 'P0001';
  end if;

  update sessions
  set state = 'LOBBY_LOCKED',
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

  return query select 'LOBBY_LOCKED'::text, v_state_version + 1;
end;
$$;
