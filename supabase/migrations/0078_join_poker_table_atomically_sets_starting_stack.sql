-- Migration: 0078_join_poker_table_atomically_sets_starting_stack
-- Poker Gameplay Phase.
--
-- 0070's join_poker_table_atomically is not edited as a file — this
-- follows the exact drop-then-recreate precedent already established
-- in this repository (e.g. 0049 evolving Session's own
-- join_participant_atomically without touching 0004). The only change:
-- the newly-seated player's stack is now initialized from the table's
-- own starting_stack config (0072) in the same insert, instead of
-- relying on poker_seats.stack's schema-level default of 0. Every
-- other check/lock/allocation behavior is byte-for-byte unchanged from
-- 0070.

drop function if exists join_poker_table_atomically(uuid, uuid, text, text, text, timestamptz);

create function join_poker_table_atomically(
  p_poker_seat_id uuid,
  p_poker_table_id uuid,
  p_display_name text,
  p_normalized_display_name text,
  p_participant_token text,
  p_joined_at timestamptz
)
returns table (
  poker_seat_id uuid,
  poker_table_id uuid,
  seat_number integer,
  display_name text,
  normalized_display_name text,
  participant_token text,
  joined_at timestamptz,
  stack integer
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_max_seats integer;
  v_closed_at timestamptz;
  v_starting_stack integer;
  v_current_seat_count integer;
  v_next_seat_number integer;
begin
  select poker_tables.max_seats, poker_tables.closed_at, poker_tables.starting_stack
    into v_max_seats, v_closed_at, v_starting_stack
  from poker_tables
  where poker_tables.poker_table_id = p_poker_table_id
  for update;

  if v_max_seats is null then
    raise exception 'POKER_TABLE_NOT_FOUND: no poker table exists for this id'
      using errcode = 'P0001';
  end if;

  if v_closed_at is not null then
    raise exception 'POKER_TABLE_CLOSED: this poker table is closed'
      using errcode = 'P0001';
  end if;

  select count(*) into v_current_seat_count
  from poker_seats
  where poker_seats.poker_table_id = p_poker_table_id;

  if v_current_seat_count >= v_max_seats then
    raise exception 'POKER_TABLE_FULL: this poker table already has the maximum number of seats filled'
      using errcode = 'P0001';
  end if;

  select coalesce(max(poker_seats.seat_number) + 1, 0) into v_next_seat_number
  from poker_seats
  where poker_seats.poker_table_id = p_poker_table_id;

  insert into poker_seats (
    poker_seat_id, poker_table_id, seat_number, display_name,
    normalized_display_name, participant_token, joined_at, stack
  )
  values (
    p_poker_seat_id, p_poker_table_id, v_next_seat_number, p_display_name,
    p_normalized_display_name, p_participant_token, p_joined_at, v_starting_stack
  );

  return query
    select poker_seats.poker_seat_id, poker_seats.poker_table_id, poker_seats.seat_number,
           poker_seats.display_name, poker_seats.normalized_display_name,
           poker_seats.participant_token, poker_seats.joined_at, poker_seats.stack
    from poker_seats
    where poker_seats.poker_seat_id = p_poker_seat_id;
end;
$$;
