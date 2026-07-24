-- Migration: 0008_start_session_atomically
-- Purpose:
-- Add current_prompt_id to sessions, then authenticate the host via the
-- stored host token, atomically re-verify the session is LOBBY_LOCKED,
-- select a prompt, and transition the session to PROMPT_ACTIVE,
-- incrementing state_version and persisting a SESSION_STARTED event —
-- all as one atomic operation. Mirrors lock_lobby_atomically's
-- row-locked re-check (0005 migration).
--
-- current_prompt_id is an explicit MVP optimization, not a commitment
-- to the long-term gameplay model — a future "rounds" concept may
-- eventually own prompt selection instead of the session row directly.
-- Nullable and never cleared once set: GET_SESSION already works for
-- any session state, so the prompt reference should stay visible after
-- RESULT_REVEAL or SESSION_COMPLETE, not just during PROMPT_ACTIVE.
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
-- Prompt selection: unlike lock_lobby_atomically/complete_session_atomically,
-- this function does not receive an event payload from the caller — the
-- payload depends on which prompt gets selected, and selection happens
-- inside this same atomic operation (not beforehand in the calling
-- code) so that a future, richer selection strategy can be introduced
-- later without opening a race between two concurrent starts. Today,
-- with exactly one prompt seeded, selection is trivially deterministic
-- (see the single marked query below) — only that query would need to
-- change later, nothing else in this function.
--
-- A session that no longer exists, has a mismatched host token, or is
-- not LOBBY_LOCKED at the moment of this check raises a distinct,
-- named exception (SESSION_NOT_FOUND / HOST_TOKEN_MISMATCH /
-- LOBBY_NOT_LOCKED) rather than being inferred from a generic error.
-- The calling adapter translates these explicitly.

alter table sessions
  add column if not exists current_prompt_id uuid null references prompts(prompt_id);

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

  if v_state <> 'LOBBY_LOCKED' then
    raise exception 'LOBBY_NOT_LOCKED: session is in % state, not LOBBY_LOCKED', v_state
      using errcode = 'P0001';
  end if;

  -- Prompt selection swap point: today, exactly one prompt exists, so
  -- this is trivially deterministic. A future selection strategy
  -- (random, round-robin, exclude-already-used) replaces only this
  -- query — no schema change, no change to anything above or below it.
  select prompt_id into v_prompt_id from prompts order by created_at asc limit 1;

  update sessions
  set state = 'PROMPT_ACTIVE',
      current_prompt_id = v_prompt_id,
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
    'SESSION_STARTED',
    jsonb_build_object('promptId', v_prompt_id)
  );

  return query select 'PROMPT_ACTIVE'::text, v_state_version + 1, v_prompt_id;
end;
$$;
