-- Migration: 0107_correct_match_result_atomically_xp_eligibility
-- Soccer Predictions — XP Eligibility / Calibration Support Slice.
-- Applies the identical change documented in 0106 to the correction
-- path, since this function independently inlines its own copy of
-- the same evaluation logic (no shared SQL helper exists between the
-- two functions in this codebase's own convention) — see 0106's own
-- comment for the full rationale.
--
-- matches.xp_eligible is locked (set_match_xp_eligibility_atomically,
-- 0102) the instant Prediction or Result evidence exists, and by the
-- time any correction can run, that evidence already exists — so
-- this function reads the exact same, unchanging fact 0106 already
-- read for the original finalization. A correction can never change
-- which side of the XP-eligible/not-eligible line its own Match
-- falls on; it can only change scoreline/goal-event facts.

drop function if exists correct_match_result_atomically(uuid, uuid);

create function correct_match_result_atomically(
  p_match_result_id uuid,
  p_finalized_by_gaming_member_id uuid
)
returns table (
  match_result_id uuid,
  match_id uuid,
  finalized_at timestamptz,
  supersedes_match_result_id uuid,
  already_finalized boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_match_id uuid;
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_home_score integer;
  v_away_score integer;
  v_activity_classification text;
  v_xp_eligible boolean;
  v_cancelled_at timestamptz;
  v_existing_finalized_at timestamptz;
  v_new_finalized_at timestamptz;
  v_supersedes_id uuid;
  v_supersedes_finalized_at timestamptz;
  r_prediction record;
  v_official_goal_count integer;
  v_first_scorer_player_id uuid;
  v_first_is_own_goal boolean;
  v_first_scorer_team_id uuid;
  v_official_first_team text;
  v_scoreline_correct boolean;
  v_goalscorer_correct boolean;
  v_goal_minute_correct boolean;
  v_first_team_correct boolean;
  v_dimension_count integer;
  v_dimension_keys text[];
  v_new_evaluation_id uuid;
  v_old_evaluation_id uuid;
  v_old_dimension_count integer;
  v_new_tier_id uuid;
  v_performance_band_key text;
  v_old_experience_summary_id uuid;
  v_new_experience_summary_id uuid;
begin
  select match_results.match_id, match_results.home_score, match_results.away_score,
         match_results.finalized_at, match_results.supersedes_match_result_id
    into v_match_id, v_home_score, v_away_score, v_existing_finalized_at, v_supersedes_id
  from match_results
  where match_results.match_result_id = p_match_result_id
  for update;

  if v_match_id is null then
    raise exception 'MATCH_RESULT_NOT_FOUND: no correction draft exists for this id'
      using errcode = 'P0001';
  end if;

  if v_supersedes_id is null then
    raise exception 'NOT_A_CORRECTION: this result does not supersede a prior finalized result'
      using errcode = 'P0001';
  end if;

  if v_existing_finalized_at is not null then
    return query select p_match_result_id, v_match_id, v_existing_finalized_at, v_supersedes_id, true;
    return;
  end if;

  select matches.cancelled_at into v_cancelled_at
  from matches
  where matches.match_id = v_match_id;

  if v_cancelled_at is not null then
    raise exception 'MATCH_CANCELLED: this match has been cancelled'
      using errcode = 'P0001';
  end if;

  select match_results.finalized_at into v_supersedes_finalized_at
  from match_results
  where match_results.match_result_id = v_supersedes_id
  for update;

  if v_supersedes_finalized_at is null then
    raise exception 'SUPERSEDED_RESULT_NOT_FINALIZED: the result being corrected is not itself finalized'
      using errcode = 'P0001';
  end if;

  v_new_finalized_at := now();

  update match_results
     set finalized_at = v_new_finalized_at
   where match_results.match_result_id = p_match_result_id;

  select matches.home_team_id, matches.away_team_id, matches.activity_classification, matches.xp_eligible
    into v_home_team_id, v_away_team_id, v_activity_classification, v_xp_eligible
  from matches
  where matches.match_id = v_match_id;

  select count(*) into v_official_goal_count
  from official_goal_events
  where official_goal_events.match_result_id = p_match_result_id
    and official_goal_events.minute_regulation between 1 and 90;

  select official_goal_events.scorer_player_id, official_goal_events.is_own_goal
    into v_first_scorer_player_id, v_first_is_own_goal
  from official_goal_events
  where official_goal_events.match_result_id = p_match_result_id
    and official_goal_events.minute_regulation between 1 and 90
  order by (official_goal_events.minute_regulation + coalesce(official_goal_events.minute_stoppage, 0)) asc,
           official_goal_events.ordinal asc
  limit 1;

  if v_first_scorer_player_id is null then
    v_official_first_team := 'NO_GOAL';
  else
    select players.team_id into v_first_scorer_team_id
    from players
    where players.player_id = v_first_scorer_player_id;

    if v_first_is_own_goal then
      v_official_first_team := case when v_first_scorer_team_id = v_home_team_id then 'AWAY' else 'HOME' end;
    else
      v_official_first_team := case when v_first_scorer_team_id = v_home_team_id then 'HOME' else 'AWAY' end;
    end if;
  end if;

  for r_prediction in
    select predictions.prediction_id, predictions.gaming_member_id, predictions.venue_activation_id,
           predictions.predicted_home_score, predictions.predicted_away_score,
           predictions.predicted_goalscorer_player_id,
           predictions.predicted_goal_minute_regulation, predictions.predicted_goal_minute_stoppage,
           predictions.predicted_first_team_to_score, predictions.created_at
    from predictions
    where predictions.match_id = v_match_id
  loop
    select evaluations.evaluation_id, evaluations.correct_dimension_count
      into v_old_evaluation_id, v_old_dimension_count
    from evaluations
    where evaluations.prediction_id = r_prediction.prediction_id
      and evaluations.match_result_id = v_supersedes_id;

    v_scoreline_correct := (r_prediction.predicted_home_score = v_home_score and r_prediction.predicted_away_score = v_away_score);

    if r_prediction.predicted_goalscorer_player_id is null then
      v_goalscorer_correct := (v_official_goal_count = 0);
    else
      v_goalscorer_correct := exists (
        select 1 from official_goal_events
        where official_goal_events.match_result_id = p_match_result_id
          and official_goal_events.minute_regulation between 1 and 90
          and official_goal_events.scorer_player_id = r_prediction.predicted_goalscorer_player_id
          and not official_goal_events.is_own_goal
      );
    end if;

    if r_prediction.predicted_goal_minute_regulation is null then
      v_goal_minute_correct := (v_official_goal_count = 0);
    else
      v_goal_minute_correct := exists (
        select 1 from official_goal_events
        where official_goal_events.match_result_id = p_match_result_id
          and official_goal_events.minute_regulation between 1 and 90
          and official_goal_events.minute_regulation = r_prediction.predicted_goal_minute_regulation
          and official_goal_events.minute_stoppage is not distinct from r_prediction.predicted_goal_minute_stoppage
      );
    end if;

    if r_prediction.predicted_first_team_to_score is null then
      v_first_team_correct := (v_official_first_team = 'NO_GOAL');
    else
      v_first_team_correct := (r_prediction.predicted_first_team_to_score = v_official_first_team);
    end if;

    v_dimension_count := (
      v_scoreline_correct::int + v_goalscorer_correct::int + v_goal_minute_correct::int + v_first_team_correct::int
    );

    v_dimension_keys := array[]::text[];
    if v_scoreline_correct then v_dimension_keys := array_append(v_dimension_keys, 'EXACT_SCORELINE'); end if;
    if v_goalscorer_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOALSCORER'); end if;
    if v_goal_minute_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOAL_MINUTE'); end if;
    if v_first_team_correct then v_dimension_keys := array_append(v_dimension_keys, 'FIRST_TEAM_TO_SCORE'); end if;

    insert into evaluations (
      prediction_id, match_result_id, scoreline_correct, goalscorer_correct,
      goal_minute_correct, first_team_to_score_correct, correct_dimension_count
    )
    values (
      r_prediction.prediction_id, p_match_result_id, v_scoreline_correct, v_goalscorer_correct,
      v_goal_minute_correct, v_first_team_correct, v_dimension_count
    )
    returning evaluations.evaluation_id into v_new_evaluation_id;

    v_performance_band_key := 'CORRECT_' || v_dimension_count || '_OF_4';

    v_old_experience_summary_id := null;
    if v_old_evaluation_id is not null then
      select experience_summaries.experience_summary_id into v_old_experience_summary_id
      from experience_summaries
      where experience_summaries.experience_key = 'SOCCER_PREDICTIONS'
        and experience_summaries.idempotency_key = v_old_evaluation_id::text;
    end if;

    select record_experience_summary_atomically.experience_summary_id into v_new_experience_summary_id
    from record_experience_summary_atomically(
      r_prediction.gaming_member_id,
      'SOCCER_PREDICTIONS',
      'SOCCER_PREDICTIONS',
      v_activity_classification,
      'ADMIN_FINALIZED',
      r_prediction.created_at,
      v_new_finalized_at,
      true,
      v_performance_band_key,
      v_new_evaluation_id::text,
      'predictions-v2',
      v_old_experience_summary_id,
      v_new_evaluation_id::text,
      jsonb_build_object(
        'correctDimensionCount', v_dimension_count,
        'scorelineCorrect', v_scoreline_correct,
        'goalscorerCorrect', v_goalscorer_correct,
        'goalMinuteCorrect', v_goal_minute_correct,
        'firstTeamCorrect', v_first_team_correct,
        'correction', true
      ),
      v_dimension_count,
      v_dimension_keys,
      coalesce(v_xp_eligible, false)
    );

    perform 1 from process_experience_summary_consequences_atomically(v_new_experience_summary_id);

    if v_old_evaluation_id is not null then
      update prize_qualifications
         set superseded_at = now()
       where prize_qualifications.evaluation_id = v_old_evaluation_id
         and prize_qualifications.superseded_at is null;
    end if;

    select prize_tiers.prize_tier_id into v_new_tier_id
    from prize_tiers
    where prize_tiers.venue_activation_id = r_prediction.venue_activation_id
      and prize_tiers.correct_dimension_count = v_dimension_count;

    if v_new_tier_id is not null then
      insert into prize_qualifications (
        evaluation_id, gaming_member_id, venue_activation_id, prize_tier_id
      )
      values (
        v_new_evaluation_id, r_prediction.gaming_member_id, r_prediction.venue_activation_id, v_new_tier_id
      );
    end if;
  end loop;

  return query select p_match_result_id, v_match_id, v_new_finalized_at, v_supersedes_id, false;
end;
$$;
