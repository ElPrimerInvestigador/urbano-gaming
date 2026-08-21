-- Migration: 0083_create_set_match_activity_classification_atomically
-- Persistent Metagame Phase 1.
--
-- The sole write path for matches.activity_classification (0082).
-- Freely settable/changeable while no Prediction or Result evidence
-- exists for the Match yet (an admin may legitimately change their
-- mind before predictions open); locked the moment either exists.
-- Idempotent: re-declaring the same already-locked value returns the
-- current state rather than erroring, mirroring
-- finalize_match_result_atomically's own already_finalized precedent.
--
-- Does not implement Official Event organizer/approval behavior —
-- OFFICIAL is accepted here purely as a legal enum value, per the
-- explicit instruction not to build Official-specific behavior merely
-- because the value is legal to set.

create function set_match_activity_classification_atomically(
  p_match_id uuid,
  p_activity_classification text
)
returns table (
  match_id uuid,
  activity_classification text,
  locked boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_current text;
  v_has_predictions boolean;
  v_has_results boolean;
begin
  if p_activity_classification not in ('TRAINING', 'CASUAL', 'RANKED', 'OFFICIAL') then
    raise exception 'INVALID_ACTIVITY_CLASSIFICATION: must be one of TRAINING, CASUAL, RANKED, OFFICIAL'
      using errcode = 'P0001';
  end if;

  select matches.activity_classification into v_current
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
    if v_current is distinct from p_activity_classification then
      raise exception 'ACTIVITY_CLASSIFICATION_LOCKED: this match already has Prediction or Result evidence and its classification cannot change'
        using errcode = 'P0001';
    end if;

    return query select p_match_id, v_current, true;
    return;
  end if;

  update matches
     set activity_classification = p_activity_classification
   where matches.match_id = p_match_id;

  return query select p_match_id, p_activity_classification, false;
end;
$$;
