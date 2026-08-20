-- Migration: 0068_create_poker_seats
-- Poker Foundation (Phase 1).
--
-- One row per seated participant. Guest-only for this phase — no
-- gaming_member_id column, matching the explicit instruction that
-- Poker must not depend on production Gaming Member authentication.
-- No "active/sitting-out" status column: this phase has no mechanic
-- that would ever branch on it (no betting, no disconnect handling
-- beyond token-based reconnect) — existence of a row IS "seated,"
-- mirroring "prefer not to add future columns prematurely."
--
-- seat_number is allocated by join_poker_table_atomically (0070) under
-- a lock on the owning poker_tables row, starting at 0 and
-- incrementing — no gaps-on-leave handling exists yet, since there is
-- no leave-table command in this phase.

create table poker_seats (
  poker_seat_id uuid primary key default gen_random_uuid(),
  poker_table_id uuid not null references poker_tables (poker_table_id),
  seat_number integer not null,
  display_name text not null,
  normalized_display_name text not null,
  participant_token text not null,
  joined_at timestamptz not null default now(),

  constraint poker_seats_seat_number_non_negative check (seat_number >= 0),
  constraint poker_seats_table_seat_unique unique (poker_table_id, seat_number),
  constraint poker_seats_table_display_name_unique unique (poker_table_id, normalized_display_name),
  constraint poker_seats_participant_token_unique unique (participant_token)
);

create index poker_seats_poker_table_id_idx on poker_seats (poker_table_id);
