-- Migration: 0076_create_poker_hand_actions
-- Poker Gameplay Phase. Append-only action history — Poker-specific,
-- deliberately not a reuse of session_events (which would falsely
-- imply Session ownership) and deliberately not a generic event-
-- sourcing framework: this exists to serve auditability, reconnect/
-- debugging, dispute inspection, and idempotent retry, nothing more.
--
-- idempotency_key is caller-supplied (a fresh value per genuine action
-- attempt, generated client-side) — a retried/duplicate request with
-- the same key returns the original result rather than reapplying the
-- action a second time, mirroring gaming_progression_events' own
-- idempotency-key convention (Predictions).

create table poker_hand_actions (
  poker_hand_action_id uuid primary key default gen_random_uuid(),
  poker_hand_id uuid not null references poker_hands (poker_hand_id),
  action_ordinal integer not null,
  street text not null,
  seat_number integer not null,
  action_type text not null,
  amount integer not null default 0,
  idempotency_key text not null,
  created_at timestamptz not null default now(),

  constraint poker_hand_actions_action_type_valid_values check (
    action_type in ('POST_SMALL_BLIND', 'POST_BIG_BLIND', 'FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN')
  ),
  constraint poker_hand_actions_amount_non_negative check (amount >= 0),
  constraint poker_hand_actions_hand_ordinal_unique unique (poker_hand_id, action_ordinal),
  constraint poker_hand_actions_hand_idempotency_unique unique (poker_hand_id, idempotency_key)
);

create index poker_hand_actions_poker_hand_id_idx on poker_hand_actions (poker_hand_id);
