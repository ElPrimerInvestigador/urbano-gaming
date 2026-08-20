-- Migration: 0073_add_stack_to_poker_seats
-- Poker Gameplay Phase. Additive only — 0068 (poker_seats) is
-- unmodified. stack is the seat's persistent, authoritative chip
-- total, carried across Hands: updated at join (via 0078's revised
-- join function) and at Hand settlement, never during a Hand's own
-- betting (a seat's live in-hand chip count is
-- stack - committed_this_hand, derived — see 0075).

alter table poker_seats
  add column stack integer not null default 0;

alter table poker_seats
  add constraint poker_seats_stack_non_negative check (stack >= 0);
