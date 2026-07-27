-- Migration: 0020_start_session_atomically_creates_interaction
-- Slice 001 — Session / Interaction separation.
--
-- START_SESSION is generalized into a re-invocable "start the next
-- interaction" command: callable once per interaction rather than
-- once per session's entire lifetime. Each call now requires
-- host-supplied prompt text (this slice's host-defined-prompt
-- requirement, folded into the same command per the accepted design's
-- stress test) and creates a brand new prompt row and a brand new
-- interaction_instances row — it no longer selects from a fixed
-- seeded prompt.
--
-- Precondition is now two-part:
-- - the session itself must be LOBBY_LOCKED (unchanged from before —
--   this remains the only state during which any interaction may run);
-- - AND the previous interaction instance for this session (if any)
--   must already be at RESULT_REVEAL. This is the new check that
--   makes the command safely re-invocable: it prevents starting a
--   second interaction while the first is still active or only
--   closed-but-not-revealed. Row-locked here for the identical reason
--   every other function in this repository row-locks its
--   authoritative check — this closes the race window between two
--   concurrent start attempts, exactly as join_participant_atomically
--   closes it for concurrent joins.
--
-- Signature change: this function gains a required third parameter
-- (p_prompt_text) that did not exist before. Postgres cannot replace
-- a function in place when its argument list changes — the prior
-- 2-argument version is dropped explicitly, then the 3-argument
-- version is created, both in this same migration. This is the one
-- deliberate, unavoidable breaking change in this slice, and it is
-- confined entirely to this one function/route.
--
-- Column-list ambiguity: the interaction_instances INSERT's column
-- list includes prompt_id and state, and the prompts INSERT's
-- RETURNING clause targets prompt_id — all of which collide with this
-- function's own RETURNS TABLE output parameter names. Same bug
-- class as 0014 (cannot be table-qualified in these positions);
-- #variable_conflict use_column resolves it the same way, for the
-- same reason.

drop function if exists start_session_atomically(uuid, text);

create function start_session_atomically(
  p_session_id uuid,
  p_host_token text,
  p_prompt_text text
)
returns table (interaction_instance_id uuid, prompt_id uuid, state text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_state text;
  v_host_token text;
  v_previous_interaction_instance_id uuid;
  v_previous_interaction_state text;
  v_prompt_id uuid;
  v_interaction_instance_id uuid;
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

  if v_session_state <> 'LOBBY_LOCKED' then
    raise exception 'LOBBY_NOT_LOCKED: session is in % state, not LOBBY_LOCKED', v_session_state
      using errcode = 'P0001';
  end if;

  if btrim(p_prompt_text) = '' then
    raise exception 'EMPTY_PROMPT_TEXT: prompt text cannot be empty'
      using errcode = 'P0001';
  end if;

  select interaction_instances.interaction_instance_id, interaction_instances.state
    into v_previous_interaction_instance_id, v_previous_interaction_state
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1
  for update;

  if v_previous_interaction_instance_id is not null
     and v_previous_interaction_state <> 'RESULT_REVEAL' then
    raise exception 'PREVIOUS_INTERACTION_NOT_REVEALED: current interaction is in % state, not RESULT_REVEAL', v_previous_interaction_state
      using errcode = 'P0001';
  end if;

  insert into prompts (text)
  values (btrim(p_prompt_text))
  returning prompts.prompt_id into v_prompt_id;

  insert into interaction_instances (session_id, prompt_id, state)
  values (p_session_id, v_prompt_id, 'PROMPT_ACTIVE')
  returning interaction_instances.interaction_instance_id into v_interaction_instance_id;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'INTERACTION_STARTED',
    jsonb_build_object('interactionInstanceId', v_interaction_instance_id, 'promptId', v_prompt_id)
  );

  return query select v_interaction_instance_id, v_prompt_id, 'PROMPT_ACTIVE'::text;
end;
$$;
