-- Migration: 0071_create_deal_poker_hand_atomically
-- Poker Foundation (Phase 1).
--
-- Idempotent per table, not sequence-capable: if a Hand already exists
-- for this table, returns it unchanged with already_dealt = true — a
-- double-tapped "Deal" is safe by construction, with no separate
-- hand-lifecycle state needed, because this phase never creates a
-- second Hand for a table at all (that requires hand-completion/
-- next-hand semantics, which belong to the following gameplay phase).
-- This is the same idempotent-on-retry shape already established by
-- finalize_match_result_atomically's own already_finalized branch.
--
-- p_deck_order and p_dealt_seat_numbers are computed by the domain
-- layer (dealHand.ts) — the shuffle (crypto.randomInt, a CSPRNG) and
-- the dealing-order rotation happen in TypeScript, not here, mirroring
-- how Predictions' geolocation distance is computed in the domain
-- layer and handed to its own atomic function as pre-computed
-- evidence. This function does not trust that evidence blindly: it
-- re-validates the deck has exactly 52 DISTINCT entries (jsonb_array_
-- length = 52 alone, already enforced by poker_hands_deck_order_shape,
-- would not catch a duplicate-with-one-missing deck) and that every
-- supplied seat number is actually currently seated at this table,
-- under the same lock used to detect an existing Hand — closing the
-- race window between the domain layer's own read of current seats
-- and this insert.

create function deal_poker_hand_atomically(
  p_poker_hand_id uuid,
  p_poker_table_id uuid,
  p_dealer_seat_number integer,
  p_dealt_seat_numbers integer[],
  p_deck_order jsonb
)
returns table (
  poker_hand_id uuid,
  poker_table_id uuid,
  hand_ordinal integer,
  dealer_seat_number integer,
  dealt_seat_numbers integer[],
  already_dealt boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_closed_at timestamptz;
  v_existing_hand_id uuid;
  v_existing_ordinal integer;
  v_existing_dealer integer;
  v_existing_dealt_seats integer[];
  v_distinct_card_count integer;
  v_seated_count integer;
begin
  select poker_tables.closed_at into v_closed_at
  from poker_tables
  where poker_tables.poker_table_id = p_poker_table_id
  for update;

  if not found then
    raise exception 'POKER_TABLE_NOT_FOUND: no poker table exists for this id'
      using errcode = 'P0001';
  end if;

  if v_closed_at is not null then
    raise exception 'POKER_TABLE_CLOSED: this poker table is closed'
      using errcode = 'P0001';
  end if;

  select poker_hands.poker_hand_id, poker_hands.hand_ordinal,
         poker_hands.dealer_seat_number, poker_hands.dealt_seat_numbers
    into v_existing_hand_id, v_existing_ordinal, v_existing_dealer, v_existing_dealt_seats
  from poker_hands
  where poker_hands.poker_table_id = p_poker_table_id
  limit 1
  for update;

  if v_existing_hand_id is not null then
    return query
      select v_existing_hand_id, p_poker_table_id, v_existing_ordinal,
             v_existing_dealer, v_existing_dealt_seats, true;
    return;
  end if;

  if array_length(p_dealt_seat_numbers, 1) is null or array_length(p_dealt_seat_numbers, 1) < 2 then
    raise exception 'NOT_ENOUGH_SEATED_PLAYERS: at least two seated players are required to deal a hand'
      using errcode = 'P0001';
  end if;

  select count(*) into v_seated_count
  from poker_seats
  where poker_seats.poker_table_id = p_poker_table_id
    and poker_seats.seat_number = any (p_dealt_seat_numbers);

  if v_seated_count <> array_length(p_dealt_seat_numbers, 1) then
    raise exception 'NOT_ENOUGH_SEATED_PLAYERS: every dealt seat must currently be seated at this table'
      using errcode = 'P0001';
  end if;

  select count(distinct card) into v_distinct_card_count
  from jsonb_array_elements_text(p_deck_order) as card;

  if v_distinct_card_count <> 52 then
    raise exception 'INVALID_DECK: the supplied deck is not a valid 52-card permutation'
      using errcode = 'P0001';
  end if;

  insert into poker_hands (
    poker_hand_id, poker_table_id, hand_ordinal, dealer_seat_number,
    dealt_seat_numbers, deck_order
  )
  values (
    p_poker_hand_id, p_poker_table_id, 1, p_dealer_seat_number,
    p_dealt_seat_numbers, p_deck_order
  );

  return query
    select p_poker_hand_id, p_poker_table_id, 1,
           p_dealer_seat_number, p_dealt_seat_numbers, false;
end;
$$;
