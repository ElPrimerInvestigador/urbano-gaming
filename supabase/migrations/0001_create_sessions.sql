-- Migration: 0001_create_sessions
-- Scope: CREATE_SESSION vertical slice only.
-- Fields limited to what is required by the finalized Session Data Model.
-- Participant records, prompts, and submissions are explicitly out of scope
-- and are NOT introduced by this migration.

create table if not exists sessions (
  session_id    uuid primary key default gen_random_uuid(),
  room_code     text not null,
  host_token    text not null,
  state         text not null default 'LOBBY_OPEN',
  state_version integer not null default 1,
  pause_reason  text null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Invariant: pause_reason must be null unless state = 'SESSION_PAUSED'.
  constraint pause_reason_requires_paused_state
    check (
      (pause_reason is null and state <> 'SESSION_PAUSED')
      or (state = 'SESSION_PAUSED')
      or (pause_reason is null)
    ),

  -- Invariant: state_version must be a positive integer.
  constraint state_version_positive check (state_version >= 1),

  -- Invariant: pause_reason, when present, is one of the two defined values.
  constraint pause_reason_valid_values
    check (pause_reason is null or pause_reason in ('MANUAL', 'HOST_DISCONNECTED')),

  -- Invariant: state must be one of the nine values defined in CLAUDE.md.
  constraint state_valid_values check (
    state in (
      'LOBBY_OPEN',
      'LOBBY_LOCKED',
      'SESSION_INTRO',
      'PROMPT_ACTIVE',
      'SUBMISSIONS_CLOSED',
      'RESULT_REVEAL',
      'SOCIAL_PAUSE',
      'SESSION_COMPLETE',
      'SESSION_PAUSED'
    )
  )
);

-- Uniqueness: room_code must be unique among *active* sessions only.
-- Active = state <> 'SESSION_COMPLETE'. This is a partial unique index,
-- not a global unique constraint, per the accepted room-code-reuse assumption.
create unique index if not exists sessions_room_code_active_unique
  on sessions (room_code)
  where (state <> 'SESSION_COMPLETE');

-- Host token must be unique per session (one host per session, cycle one).
create unique index if not exists sessions_host_token_unique
  on sessions (host_token);

-- Append-only event log. Not full event sourcing — a diagnostic/reconstruction
-- record only, per Session Engine's explicit scope limit.
create table if not exists session_events (
  event_id    uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions (session_id),
  event_type  text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists session_events_session_id_idx
  on session_events (session_id);
