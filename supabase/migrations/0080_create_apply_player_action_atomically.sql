-- Migration: 0080_create_apply_player_action_atomically
-- Poker Gameplay Phase. The single authoritative command for every
-- player action (FOLD/CHECK/CALL/BET/RAISE/ALL_IN) — one atomic
-- function, not one RPC per action, so legality/turn/state validation
-- and the resulting state mutation are always one transaction under
-- one lock. The server computes and enforces every legal action and
-- amount; the client only ever requests one.
--
-- Idempotency: p_idempotency_key is a fresh, client-generated value
-- per genuine action attempt (see poker_hand_actions, 0076). A retried
-- call with the same key returns the current Hand state without
-- reapplying the action a second time.
--
-- Minimum-raise / reopened-action rule (load-bearing): current_bet,
-- min_raise_amount, last_raise_was_full (poker_hands, 0074) and
-- acted_this_street (poker_hand_players, 0075) together implement the
-- standard rule exactly: a FULL bet or raise resets every other active
-- seat's acted_this_street to false (reopening the betting) and
-- updates min_raise_amount to the new increment; a SHORT all-in raise
-- (below min_raise_amount) still raises current_bet — so seats that
-- already acted still owe a call/fold response — but does not reset
-- acted_this_street and does not update min_raise_amount, so those
-- seats are not offered RAISE again until a genuine full raise occurs.
--
-- Street/board: community cards are never dealt or persisted here —
-- they remain pure derivations of deck_order + street (see 0074's own
-- comment). This function's only job re: streets is advancing the
-- `street` column and resetting the per-street betting fields.
--
-- Showdown: this function stops at street = 'SHOWDOWN' and returns
-- showdown_reached = true — it does not evaluate hands or settle the
-- pot itself (no Poker hand-evaluation library exists in SQL). The
-- domain layer (applyPlayerAction.ts) detects this, evaluates hands
-- and decomposes side pots in TypeScript (pokersolver — see
-- handEvaluator.ts), then calls settle_showdown_atomically (0081).
--
-- Early win (all but one player folds): settled entirely here, since
-- it needs no hand evaluation — the sole remaining player wins every
-- committed chip, no cards are revealed.

create function apply_player_action_atomically(
  p_poker_hand_id uuid,
  p_seat_number integer,
  p_action_type text,
  p_amount integer,
  p_idempotency_key text
)
returns table (
  poker_hand_id uuid,
  street text,
  current_actor_seat_number integer,
  current_bet integer,
  hand_over boolean,
  showdown_reached boolean,
  early_win_winner_seat_number integer,
  already_applied boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_poker_table_id uuid;
  v_dealer_seat_number integer;
  v_dealt_seat_numbers integer[];
  v_small_blind_seat_number integer;
  v_street text;
  v_current_bet integer;
  v_min_raise_amount integer;
  v_last_raise_was_full boolean;
  v_current_actor_seat_number integer;
  v_configured_big_blind integer;

  v_existing_ordinal integer;
  v_next_ordinal integer;

  v_committed_this_street integer;
  v_committed_this_hand integer;
  v_folded boolean;
  v_all_in boolean;
  v_stack integer;
  v_to_call integer;
  v_remaining_stack integer;

  v_new_committed_street integer;
  v_new_committed_hand integer;
  v_new_all_in boolean;
  v_new_current_bet integer;
  v_new_min_raise integer;
  v_new_last_raise_full boolean;
  v_reopen boolean := false;
  v_action_amount integer := 0;

  v_active_count integer;
  v_non_folded_count integer;
  v_non_folded_non_allin_count integer;
  v_next_actor integer;
  v_next_street text;
  v_seat_count integer;
  v_start_index integer;
  v_i integer;
  v_candidate_seat integer;
  v_candidate_folded boolean;
  v_candidate_all_in boolean;
  v_early_winner integer;
  v_total_pot integer;
  v_board_cards integer;
  v_deck_order jsonb;
  v_n integer;
  v_board jsonb;
begin
  select poker_hands.poker_table_id, poker_hands.dealer_seat_number, poker_hands.dealt_seat_numbers,
         poker_hands.small_blind_seat_number, poker_hands.street, poker_hands.current_bet,
         poker_hands.min_raise_amount, poker_hands.last_raise_was_full, poker_hands.current_actor_seat_number,
         poker_hands.deck_order
    into v_poker_table_id, v_dealer_seat_number, v_dealt_seat_numbers, v_small_blind_seat_number,
         v_street, v_current_bet, v_min_raise_amount, v_last_raise_was_full, v_current_actor_seat_number,
         v_deck_order
  from poker_hands
  where poker_hands.poker_hand_id = p_poker_hand_id
  for update;

  if not found then
    raise exception 'POKER_HAND_NOT_FOUND: no poker hand exists for this id'
      using errcode = 'P0001';
  end if;

  select poker_tables.big_blind into v_configured_big_blind
  from poker_tables where poker_tables.poker_table_id = v_poker_table_id;

  select poker_hand_actions.action_ordinal into v_existing_ordinal
  from poker_hand_actions
  where poker_hand_actions.poker_hand_id = p_poker_hand_id
    and poker_hand_actions.idempotency_key = p_idempotency_key;

  if v_existing_ordinal is not null then
    return query
      select p_poker_hand_id, poker_hands.street, poker_hands.current_actor_seat_number,
             poker_hands.current_bet, (poker_hands.street in ('SHOWDOWN', 'COMPLETE')),
             (poker_hands.street = 'SHOWDOWN'), null::integer, true
      from poker_hands where poker_hands.poker_hand_id = p_poker_hand_id;
    return;
  end if;

  if v_street in ('SHOWDOWN', 'COMPLETE') then
    raise exception 'HAND_NOT_ACCEPTING_ACTIONS: this hand is no longer accepting actions'
      using errcode = 'P0001';
  end if;

  if v_current_actor_seat_number is distinct from p_seat_number then
    raise exception 'NOT_YOUR_TURN: it is not this seat''s turn to act'
      using errcode = 'P0001';
  end if;

  select poker_hand_players.committed_this_street, poker_hand_players.committed_this_hand,
         poker_hand_players.folded, poker_hand_players.all_in
    into v_committed_this_street, v_committed_this_hand, v_folded, v_all_in
  from poker_hand_players
  where poker_hand_players.poker_hand_id = p_poker_hand_id
    and poker_hand_players.seat_number = p_seat_number
  for update;

  if not found then
    raise exception 'SEAT_NOT_IN_HAND: this seat is not part of this hand'
      using errcode = 'P0001';
  end if;

  if v_folded or v_all_in then
    raise exception 'SEAT_NOT_ELIGIBLE_TO_ACT: this seat has already folded or is already all-in'
      using errcode = 'P0001';
  end if;

  select poker_seats.stack into v_stack
  from poker_seats
  where poker_seats.poker_table_id = v_poker_table_id and poker_seats.seat_number = p_seat_number;

  v_to_call := v_current_bet - v_committed_this_street;
  v_remaining_stack := v_stack - v_committed_this_hand;

  v_new_committed_street := v_committed_this_street;
  v_new_committed_hand := v_committed_this_hand;
  v_new_all_in := false;
  v_new_current_bet := v_current_bet;
  v_new_min_raise := v_min_raise_amount;
  v_new_last_raise_full := v_last_raise_was_full;

  if p_action_type = 'FOLD' then
    update poker_hand_players
       set folded = true, acted_this_street = true
     where poker_hand_players.poker_hand_id = p_poker_hand_id and poker_hand_players.seat_number = p_seat_number;

  elsif p_action_type = 'CHECK' then
    if v_to_call <> 0 then
      raise exception 'ILLEGAL_ACTION: CHECK is not legal — an amount is owed' using errcode = 'P0001';
    end if;
    update poker_hand_players set acted_this_street = true
     where poker_hand_players.poker_hand_id = p_poker_hand_id and poker_hand_players.seat_number = p_seat_number;

  elsif p_action_type = 'CALL' then
    if v_to_call <= 0 then
      raise exception 'ILLEGAL_ACTION: CALL is not legal — nothing is owed, use CHECK' using errcode = 'P0001';
    end if;
    v_action_amount := least(v_to_call, v_remaining_stack);
    v_new_committed_street := v_committed_this_street + v_action_amount;
    v_new_committed_hand := v_committed_this_hand + v_action_amount;
    v_new_all_in := (v_action_amount = v_remaining_stack);
    update poker_hand_players
       set committed_this_street = v_new_committed_street, committed_this_hand = v_new_committed_hand,
           all_in = v_new_all_in, acted_this_street = true
     where poker_hand_players.poker_hand_id = p_poker_hand_id and poker_hand_players.seat_number = p_seat_number;

  elsif p_action_type = 'BET' then
    if v_current_bet <> 0 then
      raise exception 'ILLEGAL_ACTION: BET is not legal — a bet already exists this street, use RAISE' using errcode = 'P0001';
    end if;
    if v_remaining_stack <= 0 then
      raise exception 'ILLEGAL_ACTION: no chips remaining to bet' using errcode = 'P0001';
    end if;
    if p_amount is null or p_amount <= 0 then
      raise exception 'INVALID_AMOUNT: bet amount must be positive' using errcode = 'P0001';
    end if;
    v_action_amount := least(p_amount, v_remaining_stack);
    if v_action_amount < v_remaining_stack and v_action_amount < v_configured_big_blind then
      raise exception 'INVALID_AMOUNT: bet must be at least the big blind unless going all-in for less' using errcode = 'P0001';
    end if;
    v_new_committed_street := v_action_amount;
    v_new_committed_hand := v_committed_this_hand + v_action_amount;
    v_new_all_in := (v_action_amount = v_remaining_stack);
    v_new_current_bet := v_action_amount;
    v_new_min_raise := greatest(v_action_amount, v_configured_big_blind);
    v_new_last_raise_full := true;
    v_reopen := true;
    update poker_hand_players
       set committed_this_street = v_new_committed_street, committed_this_hand = v_new_committed_hand,
           all_in = v_new_all_in, acted_this_street = true
     where poker_hand_players.poker_hand_id = p_poker_hand_id and poker_hand_players.seat_number = p_seat_number;

  elsif p_action_type = 'RAISE' then
    if v_current_bet = 0 then
      raise exception 'ILLEGAL_ACTION: RAISE is not legal — no bet exists yet this street, use BET' using errcode = 'P0001';
    end if;
    if p_amount is null then
      raise exception 'INVALID_AMOUNT: raise-to amount is required' using errcode = 'P0001';
    end if;
    declare
      v_target integer := p_amount;
      v_additional_needed integer;
      v_increment integer;
      v_is_all_in boolean;
    begin
      v_additional_needed := v_target - v_committed_this_street;
      if v_additional_needed <= 0 then
        raise exception 'INVALID_AMOUNT: raise-to amount must exceed the current bet' using errcode = 'P0001';
      end if;
      if v_additional_needed >= v_remaining_stack then
        v_target := v_committed_this_street + v_remaining_stack;
        v_additional_needed := v_remaining_stack;
        v_is_all_in := true;
      else
        v_is_all_in := false;
      end if;
      v_increment := v_target - v_current_bet;
      if not v_is_all_in and v_increment < v_min_raise_amount then
        raise exception 'INVALID_AMOUNT: raise is below the minimum legal raise' using errcode = 'P0001';
      end if;
      v_new_committed_street := v_target;
      v_new_committed_hand := v_committed_this_hand + v_additional_needed;
      v_new_all_in := v_is_all_in;
      v_new_current_bet := v_target;
      if v_increment >= v_min_raise_amount then
        v_new_min_raise := v_increment;
        v_new_last_raise_full := true;
        v_reopen := true;
      else
        v_new_last_raise_full := false;
        v_reopen := false;
      end if;
    end;
    update poker_hand_players
       set committed_this_street = v_new_committed_street, committed_this_hand = v_new_committed_hand,
           all_in = v_new_all_in, acted_this_street = true
     where poker_hand_players.poker_hand_id = p_poker_hand_id and poker_hand_players.seat_number = p_seat_number;

  elsif p_action_type = 'ALL_IN' then
    if v_remaining_stack <= 0 then
      raise exception 'ILLEGAL_ACTION: no chips remaining to push all-in' using errcode = 'P0001';
    end if;
    declare
      v_target integer := v_committed_this_street + v_remaining_stack;
      v_increment integer;
    begin
      v_new_committed_hand := v_committed_this_hand + v_remaining_stack;
      v_new_all_in := true;
      if v_current_bet = 0 then
        v_new_committed_street := v_target;
        v_new_current_bet := v_target;
        v_new_min_raise := greatest(v_target, v_configured_big_blind);
        v_new_last_raise_full := true;
        v_reopen := true;
      else
        v_increment := v_target - v_current_bet;
        v_new_committed_street := v_target;
        if v_increment > 0 then
          v_new_current_bet := v_target;
          if v_increment >= v_min_raise_amount then
            v_new_min_raise := v_increment;
            v_new_last_raise_full := true;
            v_reopen := true;
          else
            v_new_last_raise_full := false;
          end if;
        end if;
      end if;
    end;
    update poker_hand_players
       set committed_this_street = v_new_committed_street, committed_this_hand = v_new_committed_hand,
           all_in = v_new_all_in, acted_this_street = true
     where poker_hand_players.poker_hand_id = p_poker_hand_id and poker_hand_players.seat_number = p_seat_number;

  else
    raise exception 'INVALID_ACTION_TYPE: % is not a recognized action', p_action_type using errcode = 'P0001';
  end if;

  v_action_amount := v_new_committed_hand - v_committed_this_hand;

  v_next_ordinal := coalesce(
    (select max(poker_hand_actions.action_ordinal) from poker_hand_actions where poker_hand_actions.poker_hand_id = p_poker_hand_id), 0
  ) + 1;
  insert into poker_hand_actions (poker_hand_id, action_ordinal, street, seat_number, action_type, amount, idempotency_key)
  values (p_poker_hand_id, v_next_ordinal, v_street, p_seat_number, p_action_type, v_action_amount, p_idempotency_key);

  if v_reopen then
    update poker_hands
       set current_bet = v_new_current_bet, min_raise_amount = v_new_min_raise, last_raise_was_full = v_new_last_raise_full
     where poker_hands.poker_hand_id = p_poker_hand_id;
    update poker_hand_players
       set acted_this_street = false
     where poker_hand_players.poker_hand_id = p_poker_hand_id
       and poker_hand_players.seat_number <> p_seat_number
       and poker_hand_players.seat_number = any (v_dealt_seat_numbers)
       and poker_hand_players.folded = false
       and poker_hand_players.all_in = false;
  elsif v_new_current_bet <> v_current_bet or v_new_last_raise_full <> v_last_raise_was_full then
    update poker_hands
       set current_bet = v_new_current_bet, last_raise_was_full = v_new_last_raise_full
     where poker_hands.poker_hand_id = p_poker_hand_id;
  end if;

  -- Re-read authoritative post-action state for round-completion logic.
  select poker_hands.current_bet into v_current_bet from poker_hands where poker_hands.poker_hand_id = p_poker_hand_id;

  select count(*) into v_non_folded_count
  from poker_hand_players
  where poker_hand_players.poker_hand_id = p_poker_hand_id
    and poker_hand_players.seat_number = any (v_dealt_seat_numbers)
    and poker_hand_players.folded = false;

  if v_non_folded_count = 1 then
    -- EARLY WIN: settle immediately, no showdown, no card reveal.
    select poker_hand_players.seat_number into v_early_winner
    from poker_hand_players
    where poker_hand_players.poker_hand_id = p_poker_hand_id
      and poker_hand_players.seat_number = any (v_dealt_seat_numbers)
      and poker_hand_players.folded = false;

    select sum(poker_hand_players.committed_this_hand) into v_total_pot
    from poker_hand_players
    where poker_hand_players.poker_hand_id = p_poker_hand_id
      and poker_hand_players.seat_number = any (v_dealt_seat_numbers);

    update poker_seats
       set stack = poker_seats.stack - (
         select poker_hand_players.committed_this_hand from poker_hand_players
         where poker_hand_players.poker_hand_id = p_poker_hand_id
           and poker_hand_players.seat_number = poker_seats.seat_number
       ) + case when poker_seats.seat_number = v_early_winner then v_total_pot else 0 end
     where poker_seats.poker_table_id = v_poker_table_id
       and poker_seats.seat_number = any (v_dealt_seat_numbers);

    -- The board actually reached before the fold ended the hand — never
    -- assume a full 5-card board just because the Hand is now COMPLETE.
    -- Positions are 1-indexed (jsonb_array_elements WITH ORDINALITY):
    -- hole cards occupy [1, 2*v_n]; flop = 2*v_n+2..2*v_n+4 (one burn
    -- card at 2*v_n+1); turn = 2*v_n+6 (burn at +5); river = 2*v_n+8
    -- (burn at +7) — mirrors computeBoardCards' own 0-indexed formula
    -- exactly (pokerRules.ts), offset by one for 1-indexing.
    v_n := array_length(v_dealt_seat_numbers, 1);
    v_board_cards := case v_street when 'PRE_FLOP' then 0 when 'FLOP' then 3 when 'TURN' then 4 when 'RIVER' then 5 else 0 end;

    if v_board_cards = 0 then
      v_board := '[]'::jsonb;
    else
      select coalesce(jsonb_agg(t.elem order by t.idx), '[]'::jsonb) into v_board
      from jsonb_array_elements(v_deck_order) with ordinality as t(elem, idx)
      where t.idx = any (
        case v_board_cards
          when 3 then array[2*v_n+2, 2*v_n+3, 2*v_n+4]
          when 4 then array[2*v_n+2, 2*v_n+3, 2*v_n+4, 2*v_n+6]
          when 5 then array[2*v_n+2, 2*v_n+3, 2*v_n+4, 2*v_n+6, 2*v_n+8]
        end
      );
    end if;

    insert into poker_hand_results (poker_hand_id, board, pots, showdown_hands)
    values (
      p_poker_hand_id,
      v_board,
      jsonb_build_array(jsonb_build_object(
        'amount', v_total_pot,
        'eligibleSeatNumbers', jsonb_build_array(v_early_winner),
        'payouts', jsonb_build_array(jsonb_build_object('seatNumber', v_early_winner, 'amount', v_total_pot))
      )),
      null
    );

    update poker_hands
       set street = 'COMPLETE', current_actor_seat_number = null, completed_at = now()
     where poker_hands.poker_hand_id = p_poker_hand_id;

    return query select p_poker_hand_id, 'COMPLETE'::text, null::integer, v_current_bet, true, false, v_early_winner, false;
    return;
  end if;

  -- Determine whether the current betting round is complete.
  select count(*) into v_active_count
  from poker_hand_players
  where poker_hand_players.poker_hand_id = p_poker_hand_id
    and poker_hand_players.seat_number = any (v_dealt_seat_numbers)
    and poker_hand_players.folded = false
    and poker_hand_players.all_in = false
    and (poker_hand_players.acted_this_street = false or poker_hand_players.committed_this_street <> v_current_bet);

  if v_active_count > 0 then
    -- Round not complete: advance the turn to the next eligible seat,
    -- walking dealt_seat_numbers in a simple loop starting immediately
    -- after the acting seat and wrapping around — far easier to trust
    -- than nested array-slice arithmetic.
    v_seat_count := array_length(v_dealt_seat_numbers, 1);
    v_start_index := array_position(v_dealt_seat_numbers, p_seat_number);
    v_next_actor := null;

    for v_i in 1 .. v_seat_count loop
      v_candidate_seat := v_dealt_seat_numbers[((v_start_index - 1 + v_i) % v_seat_count) + 1];
      select poker_hand_players.folded, poker_hand_players.all_in
        into v_candidate_folded, v_candidate_all_in
      from poker_hand_players
      where poker_hand_players.poker_hand_id = p_poker_hand_id
        and poker_hand_players.seat_number = v_candidate_seat;

      if not v_candidate_folded and not v_candidate_all_in then
        v_next_actor := v_candidate_seat;
        exit;
      end if;
    end loop;

    update poker_hands set current_actor_seat_number = v_next_actor where poker_hands.poker_hand_id = p_poker_hand_id;

    return query select p_poker_hand_id, v_street, v_next_actor, v_current_bet, false, false, null::integer, false;
    return;
  end if;

  -- Round complete. Determine automatic runout vs. normal street advance.
  select count(*) into v_non_folded_non_allin_count
  from poker_hand_players
  where poker_hand_players.poker_hand_id = p_poker_hand_id
    and poker_hand_players.seat_number = any (v_dealt_seat_numbers)
    and poker_hand_players.folded = false
    and poker_hand_players.all_in = false;

  if v_non_folded_non_allin_count <= 1 and v_street <> 'RIVER' then
    -- Automatic runout: no further decisions possible, skip straight to Showdown.
    update poker_hands set street = 'SHOWDOWN', current_actor_seat_number = null where poker_hands.poker_hand_id = p_poker_hand_id;
    return query select p_poker_hand_id, 'SHOWDOWN'::text, null::integer, v_current_bet, false, true, null::integer, false;
    return;
  end if;

  v_next_street := case v_street
    when 'PRE_FLOP' then 'FLOP'
    when 'FLOP' then 'TURN'
    when 'TURN' then 'RIVER'
    when 'RIVER' then 'SHOWDOWN'
  end;

  if v_next_street = 'SHOWDOWN' then
    update poker_hands set street = 'SHOWDOWN', current_actor_seat_number = null where poker_hands.poker_hand_id = p_poker_hand_id;
    return query select p_poker_hand_id, 'SHOWDOWN'::text, null::integer, v_current_bet, false, true, null::integer, false;
    return;
  end if;

  update poker_hand_players
     set committed_this_street = 0, acted_this_street = false
   where poker_hand_players.poker_hand_id = p_poker_hand_id
     and poker_hand_players.seat_number = any (v_dealt_seat_numbers)
     and poker_hand_players.folded = false
     and poker_hand_players.all_in = false;

  select poker_hand_players.seat_number into v_next_actor
  from poker_hand_players
  where poker_hand_players.poker_hand_id = p_poker_hand_id
    and poker_hand_players.seat_number = any (v_dealt_seat_numbers)
    and poker_hand_players.folded = false
    and poker_hand_players.all_in = false
  order by array_position(v_dealt_seat_numbers, poker_hand_players.seat_number)
  limit 1;

  update poker_hands
     set street = v_next_street, current_bet = 0, min_raise_amount = v_configured_big_blind,
         last_raise_was_full = true, current_actor_seat_number = v_next_actor
   where poker_hands.poker_hand_id = p_poker_hand_id;

  return query select p_poker_hand_id, v_next_street, v_next_actor, 0, false, false, null::integer, false;
end;
$$;
