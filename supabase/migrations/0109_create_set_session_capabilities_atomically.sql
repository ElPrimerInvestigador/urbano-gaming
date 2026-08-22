-- Migration: 0109_create_set_session_capabilities_atomically
-- Session Capability Architecture v1.
--
-- The sole write path for sessions.declared_capabilities (0108).
-- Byte-for-byte the same locking discipline as
-- set_match_activity_classification_atomically (0083) and
-- set_match_xp_eligibility_atomically (0102): freely settable/
-- re-settable while no real participant has ever joined this Session,
-- locked the instant one does. Idempotent: re-declaring the exact
-- same (order-independent) set once locked returns the current state
-- rather than erroring.
--
-- Every supplied key is validated against the current Product-approved
-- capability catalog (OPEN_RESPONSE, VOTING, TRIVIA, QUIZ) — an
-- unsupported key is rejected outright, the same INVALID_* precedent
-- set_match_activity_classification_atomically already established for
-- activity_classification. Duplicate inputs are silently deduplicated,
-- and the stored value is always canonically sorted — order carries no
-- Product meaning, so normalizing it here makes the locked-value
-- comparison below correct regardless of the order a caller supplies.
--
-- An empty array is a legal input and a legal locked value: this
-- function manages the snapshot only. Whether a Session may accept its
-- first real participant with an empty declared set is a separate
-- concern, enforced where that evidence is actually created — see
-- 0110 (join_participant_atomically).
--
-- Persists a SESSION_CAPABILITIES_DECLARED session_events row on every
-- real write, mirroring every other Session-mutating atomic function
-- in this schema (lock_lobby_atomically, join_participant_atomically,
-- complete_session_atomically) — never on the idempotent-already-
-- locked return path, matching lock_lobby_atomically's own precedent
-- of only recording genuine transitions.

create function set_session_capabilities_atomically(
  p_session_id uuid,
  p_host_token text,
  p_capabilities text[]
)
returns table (
  session_id uuid,
  declared_capabilities text[],
  locked boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_current text[];
  v_host_token text;
  v_normalized text[];
  v_has_participants boolean;
begin
  v_normalized := coalesce(
    array(select distinct unnest(p_capabilities) order by 1),
    array[]::text[]
  );

  if exists (
    select 1 from unnest(v_normalized) as key
    where key not in ('OPEN_RESPONSE', 'VOTING', 'TRIVIA', 'QUIZ')
  ) then
    raise exception 'INVALID_CAPABILITY_KEY: must be one of OPEN_RESPONSE, VOTING, TRIVIA, QUIZ'
      using errcode = 'P0001';
  end if;

  select sessions.declared_capabilities, sessions.host_token
    into v_current, v_host_token
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from participants where participants.session_id = p_session_id
  ) into v_has_participants;

  if v_has_participants then
    if v_current is distinct from v_normalized then
      raise exception 'CAPABILITIES_LOCKED: this session already has a real participant and its declared capabilities cannot change'
        using errcode = 'P0001';
    end if;

    return query select p_session_id, v_current, true;
    return;
  end if;

  update sessions
     set declared_capabilities = v_normalized,
         updated_at = now()
   where sessions.session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'SESSION_CAPABILITIES_DECLARED',
    jsonb_build_object('declaredCapabilities', to_jsonb(v_normalized))
  );

  return query select p_session_id, v_normalized, false;
end;
$$;
