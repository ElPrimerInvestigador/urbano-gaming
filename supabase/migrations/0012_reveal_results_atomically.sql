-- Migration: 0012_reveal_results_atomically
-- Purpose:
-- Authenticate the host via the stored host token, atomically re-verify
-- the session is SUBMISSIONS_CLOSED, and transition it to
-- RESULT_REVEAL, incrementing state_version and persisting a
-- RESULTS_REVEALED event — all as one atomic operation. Mirrors
-- lock_lobby_atomically's row-locked re-check (0005 migration).
--
-- This function only performs the state transition. Actually surfacing
-- submitted responses (with participant attribution, no anonymity,
-- voting, ranking, scoring, or winner selection) is GET_SESSION's
-- responsibility once this state is reached, not this function's.

create or replace function reveal_results_atomically(
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

  if v_state <> 'SUBMISSIONS_CLOSED' then
    raise exception 'SUBMISSIONS_NOT_CLOSED: session is in % state, not SUBMISSIONS_CLOSED', v_state
      using errcode = 'P0001';
  end if;

  update sessions
  set state = 'RESULT_REVEAL',
      state_version = state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (p_session_id, p_event_type, p_event_payload);

  return query select 'RESULT_REVEAL'::text, v_state_version + 1;
end;
$$;
