-- Migration: 0074_add_betting_state_to_poker_hands
-- Poker Gameplay Phase. Additive only — 0069 (poker_hands) is
-- unmodified.
--
-- street is the one piece of Hand state that genuinely cannot be
-- "derive, don't persist" the way segments/interaction_instances'
-- lifecycle was: PLAYER_ACTION must atomically gate on it under a row
-- lock, so it has to be a real persisted fact, not computed from a
-- child table at read time.
--
-- Community board cards are NOT persisted separately — they remain
-- pure derivations of deck_order (already authoritative, 0069) plus
-- street, using fixed index offsets past the hole cards, with a burn
-- card before each street exactly as real dealing procedure works: for
-- N = length(dealt_seat_numbers), hole cards occupy indices [0, 2N);
-- flop = indices [2N+1, 2N+3] (2N burned); turn = index 2N+5 (2N+4
-- burned); river = index 2N+7 (2N+6 burned). getTableState.ts computes
-- this the same way it already computes hole cards — no new "which
-- cards have been dealt" state needed, since the board is always a
-- pure function of (deck_order, N, street) and street alone gates how
-- much of it is legitimately visible.
--
-- small_blind_seat_number / big_blind_seat_number are persisted
-- (mirroring dealer_seat_number's own precedent) even though they are
-- computable from dealer_seat_number + dealt_seat_numbers, because
-- blinds are posted (chips committed) atomically at Hand start and
-- deserve the same auditable, explicit record dealer_seat_number
-- already has.
--
-- current_bet / min_raise_amount / last_raise_was_full together
-- implement the load-bearing minimum-raise/reopened-action rule: a
-- short all-in raise (below min_raise_amount) still raises current_bet
-- but does not update min_raise_amount and sets
-- last_raise_was_full = false, meaning a seat that had already acted
-- this street may only call/fold in response, not raise again, until a
-- genuine full raise happens. Combined with poker_hand_players.
-- acted_this_street (0075), this is the standard, correct algorithm
-- for betting-round completion and reopened action.

alter table poker_hands
  add column street text not null default 'PRE_FLOP',
  add column small_blind_seat_number integer not null default 0,
  add column big_blind_seat_number integer not null default 0,
  add column current_bet integer not null default 0,
  add column min_raise_amount integer not null default 0,
  add column last_raise_was_full boolean not null default true,
  add column current_actor_seat_number integer null,
  add column completed_at timestamptz null;

alter table poker_hands
  add constraint poker_hands_street_valid_values
  check (street in ('PRE_FLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'COMPLETE'));
