-- Migration: 0066_create_redeem_prize_qualification_atomically
-- Soccer Predictions. V1 redemption: a single admin action, exactly
-- once. Idempotent on an already-redeemed row (returns the existing
-- redeemed_at with already_redeemed = true, no error). A qualification
-- already marked superseded_at, never yet redeemed, cannot be newly
-- redeemed. Unchanged by the Founder's dimension-model correction.

create function redeem_prize_qualification_atomically(
  p_prize_qualification_id uuid,
  p_redeemed_by_gaming_member_id uuid
)
returns table (
  prize_qualification_id uuid,
  redeemed_at timestamptz,
  already_redeemed boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_existing_redeemed_at timestamptz;
  v_existing_superseded_at timestamptz;
  v_new_redeemed_at timestamptz;
begin
  select prize_qualifications.redeemed_at, prize_qualifications.superseded_at
    into v_existing_redeemed_at, v_existing_superseded_at
  from prize_qualifications
  where prize_qualifications.prize_qualification_id = p_prize_qualification_id
  for update;

  if not found then
    raise exception 'PRIZE_QUALIFICATION_NOT_FOUND: no qualification exists for this id'
      using errcode = 'P0001';
  end if;

  if v_existing_redeemed_at is not null then
    return query select p_prize_qualification_id, v_existing_redeemed_at, true;
    return;
  end if;

  if v_existing_superseded_at is not null then
    raise exception 'QUALIFICATION_SUPERSEDED: this qualification is no longer supported by the current result'
      using errcode = 'P0001';
  end if;

  v_new_redeemed_at := now();

  update prize_qualifications
     set redeemed_at = v_new_redeemed_at,
         redeemed_by_gaming_member_id = p_redeemed_by_gaming_member_id
   where prize_qualifications.prize_qualification_id = p_prize_qualification_id;

  return query select p_prize_qualification_id, v_new_redeemed_at, false;
end;
$$;
