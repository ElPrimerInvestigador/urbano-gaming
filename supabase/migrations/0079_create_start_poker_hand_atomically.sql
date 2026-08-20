-- Migration: 0079_create_start_poker_hand_atomically
-- Poker Gameplay Phase. Supersedes deal_poker_hand_atomically (0071)
-- for real gameplay — 0071 itself is left untouched (still exercised
-- by the Poker Foundation's own tests) since it proved the privacy/
-- deck foundation and 0067-0071 are not being altered. This function
-- handles both the very first Hand and every subsequent Hand: a table
-- may have any number of Hands over time now, one at a time (a new
-- Hand may start only once the current one reaches street = 'COMPLETE').
--
-- Idempotent on an already-started Hand (mirrors 0071's own
-- already_dealt convention): if the most recent Hand for this table is
-- not yet COMPLETE, that Hand is returned unchanged with
-- already_started = true rather than starting a second one — a
-- double-tapped "Start Hand" is safe by construction.
--
-- p_dealer_seat_number / p_dealt_seat_numbers / p_small_blind_seat_number
-- / p_big_blind_seat_number / p_pre_flop_first_actor_seat_number are
-- computed by the domain layer (startHand.ts, using pure functions in
-- pokerRules.ts) from currently-seated players and the previous Hand's
-- own dealer — mirroring exactly how 0071's dealing order was computed
-- in TypeScript and handed to its atomic function as pre-computed
-- evidence. This function independently re-validates every supplied
-- seat number is currently seated at this table and has a positive
-- stack before trusting it.
--
-- Blinds are posted here, atomically, as part of starting the Hand —
-- a short-stacked blind poster (stack < the configured blind) posts
-- their entire remaining stack and is immediately all-in, exactly as
-- real Hold'em rules require.

create function start_poker_hand_atomically(
  p_poker_hand_id uuid,
  p_poker_table_id uuid,
  p_dealer_seat_number integer,
  p_dealt_seat_numbers integer[],
  p_small_blind_seat_number integer,
  p_big_blind_seat_number integer,
  p_pre_flop_first_actor_seat_number integer,
  p_deck_order jsonb
)
returns table (
  poker_hand_id uuid,
  poker_table_id uuid,
  hand_ordinal integer,
  dealer_seat_number integer,
  dealt_seat_numbers integer[],
  small_blind_seat_number integer,
  big_blind_seat_number integer,
  current_actor_seat_number integer,
  street text,
  already_started boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_closed_at timestamptz;
  v_configured_small_blind integer;
  v_configured_big_blind integer;
  v_existing_hand_id uuid;
  v_existing_ordinal integer;
  v_existing_dealer integer;
  v_existing_dealt_seats integer[];
  v_existing_sb integer;
  v_existing_bb integer;
  v_existing_actor integer;
  v_existing_street text;
  v_seated_count integer;
  v_distinct_card_count integer;
  v_new_hand_ordinal integer;
  v_seat_num integer;
  v_sb_post integer;
  v_bb_post integer;
begin
  select poker_tables.closed_at, poker_tables.small_blind, poker_tables.big_blind
    into v_closed_at, v_configured_small_blind, v_configured_big_blind
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

  select poker_hands.poker_hand_id, poker_hands.hand_ordinal, poker_hands.dealer_seat_number,
         poker_hands.dealt_seat_numbers, poker_hands.small_blind_seat_number,
         poker_hands.big_blind_seat_number, poker_hands.current_actor_seat_number,
         poker_hands.street
    into v_existing_hand_id, v_existing_ordinal, v_existing_dealer, v_existing_dealt_seats,
         v_existing_sb, v_existing_bb, v_existing_actor, v_existing_street
  from poker_hands
  where poker_hands.poker_table_id = p_poker_table_id
  order by poker_hands.hand_ordinal desc
  limit 1
  for update;

  if v_existing_hand_id is not null and v_existing_street <> 'COMPLETE' then
    return query
      select v_existing_hand_id, p_poker_table_id, v_existing_ordinal, v_existing_dealer,
             v_existing_dealt_seats, v_existing_sb, v_existing_bb, v_existing_actor,
             v_existing_street, true;
    return;
  end if;

  if array_length(p_dealt_seat_numbers, 1) is null or array_length(p_dealt_seat_numbers, 1) < 2 then
    raise exception 'NOT_ENOUGH_SEATED_PLAYERS: at least two seated players with a positive stack are required to start a hand'
      using errcode = 'P0001';
  end if;

  select count(*) into v_seated_count
  from poker_seats
  where poker_seats.poker_table_id = p_poker_table_id
    and poker_seats.seat_number = any (p_dealt_seat_numbers)
    and poker_seats.stack > 0;

  if v_seated_count <> array_length(p_dealt_seat_numbers, 1) then
    raise exception 'NOT_ENOUGH_SEATED_PLAYERS: every dealt seat must currently be seated with a positive stack'
      using errcode = 'P0001';
  end if;

  select count(distinct card) into v_distinct_card_count
  from jsonb_array_elements_text(p_deck_order) as card;

  if v_distinct_card_count <> 52 then
    raise exception 'INVALID_DECK: the supplied deck is not a valid 52-card permutation'
      using errcode = 'P0001';
  end if;

  v_new_hand_ordinal := coalesce(v_existing_ordinal, 0) + 1;

  insert into poker_hands (
    poker_hand_id, poker_table_id, hand_ordinal, dealer_seat_number,
    dealt_seat_numbers, deck_order, small_blind_seat_number, big_blind_seat_number,
    street, current_bet, min_raise_amount, last_raise_was_full, current_actor_seat_number
  )
  values (
    p_poker_hand_id, p_poker_table_id, v_new_hand_ordinal, p_dealer_seat_number,
    p_dealt_seat_numbers, p_deck_order, p_small_blind_seat_number, p_big_blind_seat_number,
    'PRE_FLOP', 0, v_configured_big_blind, true, p_pre_flop_first_actor_seat_number
  );

  foreach v_seat_num in array p_dealt_seat_numbers loop
    insert into poker_hand_players (poker_hand_id, seat_number)
    values (p_poker_hand_id, v_seat_num);
  end loop;

  -- Post small blind: capped at the poster's own stack (short-stack all-in).
  select least(v_configured_small_blind, poker_seats.stack) into v_sb_post
  from poker_seats
  where poker_seats.poker_table_id = p_poker_table_id and poker_seats.seat_number = p_small_blind_seat_number;

  update poker_hand_players
     set committed_this_hand = v_sb_post,
         committed_this_street = v_sb_post,
         all_in = (v_sb_post >= (select poker_seats.stack from poker_seats
                                   where poker_seats.poker_table_id = p_poker_table_id
                                     and poker_seats.seat_number = p_small_blind_seat_number))
   where poker_hand_players.poker_hand_id = p_poker_hand_id
     and poker_hand_players.seat_number = p_small_blind_seat_number;

  insert into poker_hand_actions (poker_hand_id, action_ordinal, street, seat_number, action_type, amount, idempotency_key)
  values (p_poker_hand_id, 1, 'PRE_FLOP', p_small_blind_seat_number, 'POST_SMALL_BLIND', v_sb_post, 'hand:' || p_poker_hand_id || ':sb');

  -- Post big blind: capped at the poster's own stack (short-stack all-in).
  select least(v_configured_big_blind, poker_seats.stack) into v_bb_post
  from poker_seats
  where poker_seats.poker_table_id = p_poker_table_id and poker_seats.seat_number = p_big_blind_seat_number;

  update poker_hand_players
     set committed_this_hand = v_bb_post,
         committed_this_street = v_bb_post,
         all_in = (v_bb_post >= (select poker_seats.stack from poker_seats
                                   where poker_seats.poker_table_id = p_poker_table_id
                                     and poker_seats.seat_number = p_big_blind_seat_number))
   where poker_hand_players.poker_hand_id = p_poker_hand_id
     and poker_hand_players.seat_number = p_big_blind_seat_number;

  insert into poker_hand_actions (poker_hand_id, action_ordinal, street, seat_number, action_type, amount, idempotency_key)
  values (p_poker_hand_id, 2, 'PRE_FLOP', p_big_blind_seat_number, 'POST_BIG_BLIND', v_bb_post, 'hand:' || p_poker_hand_id || ':bb');

  update poker_hands set current_bet = v_bb_post where poker_hands.poker_hand_id = p_poker_hand_id;

  return query
    select p_poker_hand_id, p_poker_table_id, v_new_hand_ordinal, p_dealer_seat_number,
           p_dealt_seat_numbers, p_small_blind_seat_number, p_big_blind_seat_number,
           p_pre_flop_first_actor_seat_number, 'PRE_FLOP'::text, false;
end;
$$;
