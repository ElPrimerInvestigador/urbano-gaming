-- Migration: 0049_join_participant_atomically_accepts_gaming_member
-- URBANO Gaming Identity Foundation.
--
-- join_participant_atomically gains one new parameter,
-- p_gaming_member_id, defaulting to null so every pre-Identity-Foundation
-- caller (including any client still running cached JS that never
-- sends this field at all) keeps working byte-for-byte unchanged: the
-- existing Guest join path inserts gaming_member_id = null exactly as
-- it always has.
--
-- No new validation is added inside this function for the new
-- parameter. The one-Gaming-Member-per-Session rule is already fully
-- enforced by participants_session_gaming_member_unique (0046) as a
-- plain unique-violation (23505) on the insert below — the same
-- mechanism this function already relies on for
-- participants_session_display_name_unique's own DisplayNameTakenError
-- translation, one layer up in SupabaseSessionRepository. Trust in
-- p_gaming_member_id's authenticity (that it names a real, verified
-- Gaming Member and was not supplied by an untrusted client) is the
-- caller's responsibility — see lib/gaming's server-side JWT
-- verification — not re-checked here, mirroring how this function has
-- never re-verified p_participant_token's provenance either.
--
-- Signature change (8 args -> 9): requires the drop-then-create pattern
-- established in 0017-0020 and reused in 0022, 0026, 0033, and 0037.

drop function if exists join_participant_atomically(uuid, uuid, text, text, text, timestamptz, text, jsonb);

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
begin
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
