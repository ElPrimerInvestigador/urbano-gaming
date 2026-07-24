-- Migration: 0013_fix_ambiguous_state_column_references
-- Purpose:
-- Fix a real bug discovered only through live execution against a real
-- Postgres database (never caught by any unit test, since the entire
-- test suite exercises the in-memory repository, which has no concept
-- of SQL identifier resolution).
--
-- lock_lobby_atomically (0005), complete_session_atomically (0006),
-- start_session_atomically (0008), close_submissions_atomically
-- (0011), and reveal_results_atomically (0012) all declare
-- RETURNS TABLE (state text, state_version integer, ...). In PL/pgSQL,
-- this implicitly creates OUT parameters named `state` and
-- `state_version`, in scope for the entire function body. Each of
-- these functions also runs an unqualified
-- `SELECT state, state_version, host_token INTO ... FROM sessions`,
-- and `state`/`state_version` are ambiguous between the table's
-- columns and the function's own OUT parameters — Postgres raises
-- "column reference is ambiguous" (SQLSTATE 42702) at execution time.
--
-- submit_response_atomically (0010) does not have this bug: its output
-- columns are submission_id/prompt_id/updated_at, none of which
-- collide with the sessions columns it reads. create_session_atomically
-- (0002) and join_participant_atomically (0004) return void, so no
-- output-column collision is possible there either.
--
-- Fix: qualify the source table's columns explicitly (sessions.state,
-- sessions.state_version) in each affected function's SELECT ... INTO,
-- which resolves the ambiguity in favor of the table column. The same
-- ambiguity also existed a second time in each function's own
-- UPDATE ... SET state_version = state_version + 1 (the RHS read is
-- ambiguous too, even though the LHS target is not) — fixed by reading
-- the already-tracked v_state_version variable instead of re-reading
-- the column. No behavior changes beyond making these functions
-- actually executable — per this repository's migration-immutability
-- discipline (see 0004's comment on 0003 being "frozen"), the original
-- migrations are left as-is; this fixes them forward via
-- CREATE OR REPLACE FUNCTION rather than editing already-applied files.

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
  select sessions.state, sessions.state_version, sessions.host_token
    into v_state, v_state_version, v_host_token
  from sessions
  where sessions.session_id = p_session_id
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
      state_version = v_state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (p_session_id, p_event_type, p_event_payload);

  return query select 'LOBBY_LOCKED'::text, v_state_version + 1;
end;
$$;

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
  select sessions.state, sessions.state_version, sessions.host_token
    into v_state, v_state_version, v_host_token
  from sessions
  where sessions.session_id = p_session_id
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
      state_version = v_state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (p_session_id, p_event_type, p_event_payload);

  return query select 'SESSION_COMPLETE'::text, v_state_version + 1;
end;
$$;

create or replace function start_session_atomically(
  p_session_id uuid,
  p_host_token text
)
returns table (state text, state_version integer, current_prompt_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
  v_state_version integer;
  v_host_token text;
  v_prompt_id uuid;
begin
  select sessions.state, sessions.state_version, sessions.host_token
    into v_state, v_state_version, v_host_token
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if v_state <> 'LOBBY_LOCKED' then
    raise exception 'LOBBY_NOT_LOCKED: session is in % state, not LOBBY_LOCKED', v_state
      using errcode = 'P0001';
  end if;

  select prompt_id into v_prompt_id from prompts order by created_at asc limit 1;

  update sessions
  set state = 'PROMPT_ACTIVE',
      current_prompt_id = v_prompt_id,
      state_version = v_state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (p_session_id, 'SESSION_STARTED', jsonb_build_object('promptId', v_prompt_id));

  return query select 'PROMPT_ACTIVE'::text, v_state_version + 1, v_prompt_id;
end;
$$;

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
  select sessions.state, sessions.state_version, sessions.host_token
    into v_state, v_state_version, v_host_token
  from sessions
  where sessions.session_id = p_session_id
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
      state_version = v_state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (p_session_id, p_event_type, p_event_payload);

  return query select 'SUBMISSIONS_CLOSED'::text, v_state_version + 1;
end;
$$;

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
  select sessions.state, sessions.state_version, sessions.host_token
    into v_state, v_state_version, v_host_token
  from sessions
  where sessions.session_id = p_session_id
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
      state_version = v_state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (p_session_id, p_event_type, p_event_payload);

  return query select 'RESULT_REVEAL'::text, v_state_version + 1;
end;
$$;
