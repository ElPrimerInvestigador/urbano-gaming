-- Migration: 0011_close_submissions_atomically
-- Purpose:
-- Authenticate the host via the stored host token, atomically re-verify
-- the session is PROMPT_ACTIVE, and transition it to
-- SUBMISSIONS_CLOSED, incrementing state_version and persisting a
-- SUBMISSIONS_CLOSED event — all as one atomic operation. Mirrors
-- lock_lobby_atomically's row-locked re-check (0005 migration).
--
-- Host-triggered only — no timers, no background jobs, no automatic
-- closure in this MVP.

create or replace function close_submissions_atomically(
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

  if v_state <> 'PROMPT_ACTIVE' then
    raise exception 'PROMPT_NOT_ACTIVE: session is in % state, not PROMPT_ACTIVE', v_state
      using errcode = 'P0001';
  end if;

  update sessions
  set state = 'SUBMISSIONS_CLOSED',
      state_version = state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (p_session_id, p_event_type, p_event_payload);

  return query select 'SUBMISSIONS_CLOSED'::text, v_state_version + 1;
end;
$$;
