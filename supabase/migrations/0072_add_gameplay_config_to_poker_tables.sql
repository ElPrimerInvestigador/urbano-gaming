-- Migration: 0072_add_gameplay_config_to_poker_tables
-- Poker Gameplay Phase. Additive only — 0067 (poker_tables) is
-- unmodified. Smallest config needed for real No-Limit Hold'em: a
-- starting stack for newly-seated players and the blind sizes.
-- Deliberately no blind schedule, no rebuy/add-on config — those are
-- explicitly out of scope for this phase.

alter table poker_tables
  add column starting_stack integer not null default 1000,
  add column small_blind integer not null default 5,
  add column big_blind integer not null default 10;

alter table poker_tables
  add constraint poker_tables_starting_stack_positive check (starting_stack > 0);
alter table poker_tables
  add constraint poker_tables_small_blind_positive check (small_blind > 0);
alter table poker_tables
  add constraint poker_tables_big_blind_greater_than_small check (big_blind > small_blind);
