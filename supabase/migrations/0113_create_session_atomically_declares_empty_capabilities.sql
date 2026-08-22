-- Migration: 0113_create_session_atomically_declares_empty_capabilities
-- Session Capability Architecture v1.
--
-- 0029's own create_session_atomically is not edited as a file —
-- CREATE OR REPLACE, since neither the parameter list nor the return
-- shape changes (mirrors 0029's own reasoning for why it could reuse
-- CREATE OR REPLACE rather than drop-then-create).
--
-- The only behavioral change: every newly created session now
-- explicitly receives declared_capabilities = '{}'::text[] — an
-- empty, but genuinely declared (not LEGACY_UNDECLARED), capability
-- set awaiting host configuration. Without this, sessions.declared_
-- capabilities' own column default (none — see 0108) would leave
-- every new session NULL, indistinguishable from a true pre-migration
-- LEGACY_UNDECLARED row. CREATE_SESSION's own external contract is
-- unchanged (still no client-supplied capability input; this value is
-- server-assigned, matching this route's own "everything server-
-- assigned" discipline) — a host declares real capabilities
-- afterward, before first join, via set_session_capabilities_atomically
-- (0109).

create or replace function create_session_atomically(
  p_session_id uuid,
  p_room_code text,
  p_host_token text,
  p_state text,
  p_state_version integer,
  p_pause_reason text,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_event_type text,
  p_event_payload jsonb,
  p_predecessor_session_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into sessions (
    session_id,
    room_code,
    host_token,
    state,
    state_version,
    pause_reason,
    created_at,
    updated_at,
    predecessor_session_id,
    declared_capabilities
  )
  values (
    p_session_id,
    p_room_code,
    p_host_token,
    p_state,
    p_state_version,
    p_pause_reason,
    p_created_at,
    p_updated_at,
    p_predecessor_session_id,
    array[]::text[]
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
