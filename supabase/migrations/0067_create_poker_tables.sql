-- Migration: 0067_create_poker_tables
-- Poker Foundation (Phase 1) — Poker Table / seating / authoritative
-- deck / private hole cards / role-aware projection only. No betting,
-- no chips, no streets, no showdown (see
-- POKER_FOUNDATION_IMPLEMENTATION_RECORD.md).
--
-- A standalone module, deliberately not built on sessions/segments/
-- interaction_instances: a Poker Table's real lifecycle (waiting for
-- seats -> hand in progress -> between hands -> closed, with hands
-- repeating indefinitely) does not map onto sessions.state's closed
-- enum, and a Poker Hand's many sequential per-seat actions across
-- multiple betting rounds has no honest representation as an
-- Interaction Instance's one-prompt/N-submissions/one-reveal shape.
-- See the Private Table readiness gate for the full architecture
-- comparison. Room code / host token generation is reused directly
-- from lib/session (pure, dependency-free utilities) — this table
-- itself is new and independent.
--
-- No lifecycle/status column beyond closed_at, mirroring segments' own
-- "derive, don't persist" precedent: whether a table is "accepting
-- participants" vs "hand dealt" is derived from whether a poker_hands
-- row exists for it (0069), not stored here.

create table poker_tables (
  poker_table_id uuid primary key default gen_random_uuid(),
  room_code text not null,
  host_token text not null,
  max_seats integer not null default 6,
  closed_at timestamptz null,
  created_at timestamptz not null default now(),

  constraint poker_tables_max_seats_range check (max_seats between 2 and 6)
);

-- Uniqueness: room_code must be unique among *active* (not closed)
-- poker tables only — mirrors sessions_room_code_active_unique exactly.
create unique index poker_tables_room_code_active_unique
  on poker_tables (room_code)
  where closed_at is null;
