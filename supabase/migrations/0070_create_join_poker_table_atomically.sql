-- Migration: 0070_create_join_poker_table_atomically
-- Poker Foundation (Phase 1).
--
-- Locks the poker_tables row (for update) before reading the current
-- seat count and allocating the next seat_number — this serializes
-- every concurrent join attempt against the same table through this
-- one function, so "count existing seats, compute next seat_number,
-- insert" is race-free without a separate sequence object. Mirrors
-- join_participant_atomically's own row-lock-then-insert shape (0049).
--
-- No idempotent-return path, mirroring joinSession.ts's own documented
-- behavior exactly: a genuine retry with the same display name hits
-- poker_seats_table_display_name_unique and is translated to
-- PokerDisplayNameTakenError by the repository layer, the same
-- pattern already established for Session's own DisplayNameTakenError.

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
  joined_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_max_seats integer;
  v_closed_at timestamptz;
  v_current_seat_count integer;
  v_next_seat_number integer;
begin
  select poker_tables.max_seats, poker_tables.closed_at
    into v_max_seats, v_closed_at
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
    normalized_display_name, participant_token, joined_at
  )
  values (
    p_poker_seat_id, p_poker_table_id, v_next_seat_number, p_display_name,
    p_normalized_display_name, p_participant_token, p_joined_at
  );

  return query
    select poker_seats.poker_seat_id, poker_seats.poker_table_id, poker_seats.seat_number,
           poker_seats.display_name, poker_seats.normalized_display_name,
           poker_seats.participant_token, poker_seats.joined_at
    from poker_seats
    where poker_seats.poker_seat_id = p_poker_seat_id;
end;
$$;
