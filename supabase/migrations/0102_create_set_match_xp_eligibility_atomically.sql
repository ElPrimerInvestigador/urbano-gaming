-- Migration: 0102_create_set_match_xp_eligibility_atomically
-- Soccer Predictions — XP Eligibility / Calibration Support Slice.
--
-- The sole write path for matches.xp_eligible (0101). Byte-for-byte
-- the same locking discipline as
-- set_match_activity_classification_atomically (0083): freely
-- settable/re-settable while no Prediction or Result evidence exists
-- for the Match yet, locked the instant either exists. Idempotent:
-- re-declaring the same already-locked value returns the current
-- state rather than erroring.
--
-- Unlike Activity Classification, there is no "must be classified
-- before accepting Predictions" precondition here — Prediction
-- submission (upsert_prediction_atomically) has, and needs, zero
-- dependency on this column. A Match can be fully playable with
-- xp_eligible left NULL forever; declaring it is optional, but once
-- declared (true or false), it locks under the identical evidence
-- rule, which is what prevents previously non-XP activity from ever
-- being retroactively converted into XP-eligible activity.

create function set_match_xp_eligibility_atomically(
  p_match_id uuid,
  p_xp_eligible boolean
)
returns table (
  match_id uuid,
  xp_eligible boolean,
  locked boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_current boolean;
  v_has_predictions boolean;
  v_has_results boolean;
begin
  select matches.xp_eligible into v_current
  from matches
  where matches.match_id = p_match_id
  for update;

  if not found then
    raise exception 'MATCH_NOT_FOUND: no match exists for this match_id'
      using errcode = 'P0001';
  end if;

  select exists(select 1 from predictions where predictions.match_id = p_match_id) into v_has_predictions;
  select exists(select 1 from match_results where match_results.match_id = p_match_id) into v_has_results;

  if v_has_predictions or v_has_results then
    if v_current is distinct from p_xp_eligible then
      raise exception 'XP_ELIGIBILITY_LOCKED: this match already has Prediction or Result evidence and its XP eligibility cannot change'
        using errcode = 'P0001';
    end if;

    return query select p_match_id, v_current, true;
    return;
  end if;

  update matches
     set xp_eligible = p_xp_eligible
   where matches.match_id = p_match_id;

  return query select p_match_id, p_xp_eligible, false;
end;
$$;
