-- Migration: 0081_create_settle_showdown_atomically
-- Poker Gameplay Phase. The Showdown counterpart to
-- apply_player_action_atomically's own early-win settlement branch —
-- called by the domain layer only after it has evaluated every
-- contesting hand and decomposed the pot(s) in TypeScript (pokersolver
-- + the side-pot algorithm in pokerRules.ts), since no Poker hand
-- evaluator exists in SQL. This is an internal function: no API route
-- accepts p_pots/p_showdown_hands directly from a client — only
-- applyPlayerAction.ts calls it, immediately after
-- apply_player_action_atomically reports showdown_reached = true.
--
-- Trust boundary, explicit: this function does not re-verify hand
-- ranks or winner correctness — it trusts the caller's pot/winner
-- computation. It DOES independently enforce the one invariant that
-- matters regardless of who computed the payouts: total payouts across
-- every pot must exactly equal the sum of every seat's
-- committed_this_hand for this Hand — chip conservation, checked here
-- as a hard failure, not a silent trust.
--
-- Idempotent: if the Hand is already street = 'COMPLETE', returns the
-- existing poker_hand_results row unchanged rather than re-settling
-- (which would pay out a second time).

create function settle_showdown_atomically(
  p_poker_hand_id uuid,
  p_board jsonb,
  p_pots jsonb,
  p_showdown_hands jsonb
)
returns table (
  poker_hand_id uuid,
  already_settled boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_poker_table_id uuid;
  v_dealt_seat_numbers integer[];
  v_street text;
  v_total_committed integer;
  v_total_payouts integer;
  v_seat_num integer;
  v_payout integer;
begin
  select poker_hands.poker_table_id, poker_hands.dealt_seat_numbers, poker_hands.street
    into v_poker_table_id, v_dealt_seat_numbers, v_street
  from poker_hands
  where poker_hands.poker_hand_id = p_poker_hand_id
  for update;

  if not found then
    raise exception 'POKER_HAND_NOT_FOUND: no poker hand exists for this id'
      using errcode = 'P0001';
  end if;

  if v_street = 'COMPLETE' then
    return query select p_poker_hand_id, true;
    return;
  end if;

  if v_street <> 'SHOWDOWN' then
    raise exception 'HAND_NOT_AT_SHOWDOWN: this hand has not reached showdown'
      using errcode = 'P0001';
  end if;

  select sum(poker_hand_players.committed_this_hand) into v_total_committed
  from poker_hand_players
  where poker_hand_players.poker_hand_id = p_poker_hand_id
    and poker_hand_players.seat_number = any (v_dealt_seat_numbers);

  select coalesce(sum((payout->>'amount')::integer), 0) into v_total_payouts
  from jsonb_array_elements(p_pots) as pot,
       jsonb_array_elements(pot->'payouts') as payout;

  if v_total_payouts <> v_total_committed then
    raise exception 'CHIP_CONSERVATION_VIOLATION: total payouts (%) do not match total committed chips (%)',
      v_total_payouts, v_total_committed using errcode = 'P0001';
  end if;

  -- Apply: each seat's new stack = old stack - their own committed_this_hand + their total payout.
  for v_seat_num in select unnest(v_dealt_seat_numbers) loop
    select coalesce(sum((payout->>'amount')::integer), 0) into v_payout
    from jsonb_array_elements(p_pots) as pot,
         jsonb_array_elements(pot->'payouts') as payout
    where (payout->>'seatNumber')::integer = v_seat_num;

    update poker_seats
       set stack = poker_seats.stack
         - (select poker_hand_players.committed_this_hand from poker_hand_players
            where poker_hand_players.poker_hand_id = p_poker_hand_id and poker_hand_players.seat_number = v_seat_num)
         + v_payout
     where poker_seats.poker_table_id = v_poker_table_id and poker_seats.seat_number = v_seat_num;
  end loop;

  insert into poker_hand_results (poker_hand_id, board, pots, showdown_hands)
  values (p_poker_hand_id, p_board, p_pots, p_showdown_hands);

  update poker_hands
     set street = 'COMPLETE', current_actor_seat_number = null, completed_at = now()
   where poker_hands.poker_hand_id = p_poker_hand_id;

  return query select p_poker_hand_id, false;
end;
$$;
