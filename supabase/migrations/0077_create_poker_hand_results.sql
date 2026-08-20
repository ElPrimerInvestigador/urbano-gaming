-- Migration: 0077_create_poker_hand_results
-- Poker Gameplay Phase. The smallest useful authoritative result
-- record — not Poker analytics, not a Gaming XP source (Poker XP/
-- rating is explicitly out of scope for this phase and this table
-- carries nothing that implies otherwise).
--
-- pots: jsonb array, one entry per pot (main + zero or more side
-- pots), each { amount, eligibleSeatNumbers, winnerSeatNumbers,
-- payoutPerWinner, oddChipSeatNumber }. Computed once, in the domain
-- layer (side-pot decomposition and hand evaluation both happen in
-- TypeScript — see settle_showdown_atomically, 0080), persisted here
-- as the authoritative settlement record.
--
-- showdown_hands: jsonb object keyed by seat_number, present only for
-- seats whose hand was revealed — every seat that reached Showdown
-- without folding, per this phase's chosen reveal rule (see
-- POKER_GAMEPLAY_IMPLEMENTATION_RECORD.md). Null entirely for a Hand
-- that ended by fold (early win) — no cards are revealed in that case.
-- Folded seats never appear here, at any point.
--
-- board: the final community cards actually reached (may be fewer
-- than 5 for a Hand that ended before Showdown). Redundant with what
-- deck_order + street already make derivable, but persisted here for
-- a cheap, self-contained historical record that survives even though
-- deck_order itself is never exposed to any client.

create table poker_hand_results (
  poker_hand_id uuid primary key references poker_hands (poker_hand_id),
  board jsonb not null default '[]'::jsonb,
  pots jsonb not null,
  showdown_hands jsonb null,
  completed_at timestamptz not null default now(),

  constraint poker_hand_results_pots_is_array check (jsonb_typeof(pots) = 'array')
);
