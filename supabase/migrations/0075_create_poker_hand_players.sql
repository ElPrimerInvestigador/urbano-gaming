-- Migration: 0075_create_poker_hand_players
-- Poker Gameplay Phase.
--
-- One row per seat that was eligible for a given Hand (matches
-- poker_hands.dealt_seat_numbers, 0069) — the live, per-Hand betting
-- state that a fixed array on poker_hands cannot represent. A seat's
-- current in-hand chip count is always
-- (poker_seats.stack - committed_this_hand) — derived, never stored
-- redundantly.
--
-- acted_this_street is the other half of the minimum-raise/reopened-
-- action rule (see 0074's own comment): true once this seat has
-- responded to the current betting sequence on this street; reset to
-- false for every other active seat whenever a FULL bet/raise occurs,
-- left unchanged on a short all-in raise (which raises current_bet but
-- does not reopen action for seats that already acted).

create table poker_hand_players (
  poker_hand_id uuid not null references poker_hands (poker_hand_id),
  seat_number integer not null,
  committed_this_hand integer not null default 0,
  committed_this_street integer not null default 0,
  folded boolean not null default false,
  all_in boolean not null default false,
  acted_this_street boolean not null default false,

  primary key (poker_hand_id, seat_number),
  constraint poker_hand_players_committed_this_hand_non_negative check (committed_this_hand >= 0),
  constraint poker_hand_players_committed_this_street_non_negative check (committed_this_street >= 0)
);
