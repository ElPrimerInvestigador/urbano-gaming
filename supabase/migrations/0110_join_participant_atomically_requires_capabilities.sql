-- Migration: 0110_join_participant_atomically_requires_capabilities
-- Session Capability Architecture v1.
--
-- 0049's own join_participant_atomically is not edited as a file —
-- drop-then-recreate, the same precedent already established in this
-- file's own history (0017-0020, 0022, 0026, 0033, 0037). The only
-- behavioral change: a Session must have at least one declared
-- capability before it will accept its first real participant.
--
-- This is the enforcement half of the same boundary
-- upsert_prediction_atomically_requires_classification (0084) already
-- established for Predictions: a Session that has never declared what
-- it may run is not yet a real, joinable gameplay context — allowing
-- a first join to attach evidence to an undeclared (or empty)
-- capability set would either permanently lock that Session into
-- uselessness (if the host never configures it afterward) or silently
-- treat "not yet configured" as equivalent to "intentionally
-- declared" — both wrong. Requiring the precondition here, at the one
-- action that actually creates evidence, is the smaller and more
-- truthful fix than adding a second lifecycle state to Session itself.
--
-- Applies uniformly to every Session, including LEGACY_UNDECLARED rows
-- (declared_capabilities is null): a legacy Session already carrying
-- real historical participants is completely unaffected (this check
-- only runs before a *new* participant is ever inserted); a legacy
-- Session with zero participants so far is treated exactly like any
-- other undeclared Session — its host must declare a capability set
-- (via set_session_capabilities_atomically, 0109) before anyone new
-- may join. No legacy-specific branch is needed: one uniform check,
-- applied to every Session equally, is the smaller and more truthful
-- implementation.
--
-- Signature is unchanged from 0049 (still 9 parameters).

drop function if exists join_participant_atomically(uuid, uuid, text, text, text, timestamptz, text, jsonb, uuid);

create function join_participant_atomically(
  p_participant_id uuid,
  p_session_id uuid,
  p_display_name text,
  p_normalized_display_name text,
  p_participant_token text,
  p_joined_at timestamptz,
  p_event_type text,
  p_event_payload jsonb,
  p_gaming_member_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
  v_declared_capabilities text[];
begin
  select sessions.state, sessions.declared_capabilities
    into v_state, v_declared_capabilities
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_state <> 'LOBBY_OPEN' then
    raise exception 'SESSION_NOT_JOINABLE: session is in % state, not LOBBY_OPEN', v_state
      using errcode = 'P0001';
  end if;

  if coalesce(array_length(v_declared_capabilities, 1), 0) = 0 then
    raise exception 'SESSION_CAPABILITIES_NOT_DECLARED: this session has not declared any gameplay capability yet'
      using errcode = 'P0001';
  end if;

  insert into participants (
    participant_id,
    session_id,
    display_name,
    normalized_display_name,
    participant_token,
    joined_at,
    gaming_member_id
  )
  values (
    p_participant_id,
    p_session_id,
    p_display_name,
    p_normalized_display_name,
    p_participant_token,
    p_joined_at,
    p_gaming_member_id
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
