-- Migration: 0069_create_poker_hands
-- Poker Foundation (Phase 1).
--
-- deck_order is the full authoritative 52-card shuffled permutation —
-- structured state, not 52 persistent card-location rows (pressure-
-- tested per the readiness gate: a permutation array makes "no
-- duplicate cards, no card in two locations" true BY CONSTRUCTION,
-- with deterministic, cheap derivation of any card's location from
-- index arithmetic alone). This column is server-only, authoritative
-- state: no repository method or API route may ever serialize it to a
-- client — see getTableState.ts's own comment for the explicit-
-- projection-construction discipline that enforces this at the
-- application layer, the same boundary model this entire codebase
-- already relies on (no RLS; every write and read goes through
-- service-role Supabase calls gated by domain-layer logic).
--
-- dealt_seat_numbers is the Hand's own frozen participant list, in
-- real dealing order (starting immediately after dealer_seat_number,
-- wrapping around) — the seat at dealt_seat_numbers[i] holds
-- deck_order[i] and deck_order[length(dealt_seat_numbers) + i] as its
-- two hole cards (one card to each active player in turn, twice
-- around — the real rule, not a simplification). A seat NOT in this
-- array simply has no hole cards for this Hand, whether because they
-- joined after dealing began or were never seated — this is how "join
-- mid-Hand waits for the next Hand" is represented, with no separate
-- state needed.
--
-- Phase 1 boundary, explicit: unique(poker_table_id, hand_ordinal)
-- exists for future-correctness, but this phase's own atomic function
-- (0071) never creates a second Hand for a table — dealing is
-- idempotent per table, not sequence-capable, until hand-completion/
-- next-hand semantics exist. No lifecycle/state column: existence of
-- this row IS "dealt" (deal_hand_atomically creates the Hand and
-- populates deck_order in one atomic step — there is no meaningful
-- "created but not yet dealt" state for any caller to observe).

create table poker_hands (
  poker_hand_id uuid primary key default gen_random_uuid(),
  poker_table_id uuid not null references poker_tables (poker_table_id),
  hand_ordinal integer not null,
  dealer_seat_number integer not null,
  dealt_seat_numbers integer[] not null,
  deck_order jsonb not null,
  dealt_at timestamptz not null default now(),

  constraint poker_hands_table_ordinal_unique unique (poker_table_id, hand_ordinal),
  constraint poker_hands_deck_order_shape
    check (jsonb_typeof(deck_order) = 'array' and jsonb_array_length(deck_order) = 52),
  constraint poker_hands_dealt_seat_numbers_min
    check (array_length(dealt_seat_numbers, 1) >= 2)
);

create index poker_hands_poker_table_id_idx on poker_hands (poker_table_id);
