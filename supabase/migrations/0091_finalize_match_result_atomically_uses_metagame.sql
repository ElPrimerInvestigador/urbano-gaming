-- Migration: 0091_finalize_match_result_atomically_uses_metagame
-- Persistent Metagame Phase 1.
--
-- 0064's own finalize_match_result_atomically is not edited as a file
-- — this follows the exact drop-then-recreate precedent already
-- established in this repository. Evaluation math and Prize
-- Qualification logic are byte-for-byte unchanged from 0064. The only
-- behavioral change: this function no longer writes
-- gaming_progression_events directly. It reports normalized facts —
-- meaningful_participation, performance_band_key — to
-- record_experience_summary_atomically (0089), then calls
-- process_experience_summary_consequences_atomically (0090) to let
-- Metagame policy decide the XP consequence. This function never
-- reads gaming_xp_rules or gaming_category_participation_policy —
-- per the canonical boundary, Predictions reports facts, Metagame
-- selects consequences.
--
-- meaningful_participation is always true for every row this loop
-- processes: every row in `predictions` for this match already passed
-- upsert_prediction_atomically's own checks (valid, venue-eligible,
-- submitted before kickoff) by construction — there is no "invalid
-- Prediction" state reaching this loop to report as false.
--
-- occurred_at is predictions.created_at — the first accepted
-- submission's own timestamp, never moved by a later pre-kickoff
-- revision (predictions.updated_at continues tracking those; this
-- function never reads it for this purpose).
--
-- performance_band_key ('CORRECT_<n>_OF_4') is a plain factual label
-- derived from the same correct_dimension_count this function already
-- computes — never a rule_key, never a points decision.
--
-- gaming_progression_events (0061) receives no new writes from this
-- function as of this migration. It is not dropped.

drop function if exists finalize_match_result_atomically(uuid, uuid);

create function finalize_match_result_atomically(
  p_match_result_id uuid,
  p_finalized_by_gaming_member_id uuid
)
returns table (
  match_result_id uuid,
  match_id uuid,
  finalized_at timestamptz,
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
  v_existing_finalized_at timestamptz;
  v_new_finalized_at timestamptz;
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
  v_evaluation_id uuid;
  v_tier_id uuid;
  v_performance_band_key text;
  v_experience_summary_id uuid;
begin
  select match_results.match_id, match_results.home_score, match_results.away_score, match_results.finalized_at
    into v_match_id, v_home_score, v_away_score, v_existing_finalized_at
  from match_results
  where match_results.match_result_id = p_match_result_id
  for update;

  if v_match_id is null then
    raise exception 'MATCH_RESULT_NOT_FOUND: no draft result exists for this id'
      using errcode = 'P0001';
  end if;

  if v_existing_finalized_at is not null then
    return query select p_match_result_id, v_match_id, v_existing_finalized_at, true;
    return;
  end if;

  v_new_finalized_at := now();

  update match_results
     set finalized_at = v_new_finalized_at
   where match_results.match_result_id = p_match_result_id;

  select matches.home_team_id, matches.away_team_id, matches.activity_classification
    into v_home_team_id, v_away_team_id, v_activity_classification
  from matches
  where matches.match_id = v_match_id;

  select count(*) into v_official_goal_count
  from official_goal_events
  where official_goal_events.match_result_id = p_match_result_id;

  select official_goal_events.scorer_player_id, official_goal_events.is_own_goal
    into v_first_scorer_player_id, v_first_is_own_goal
  from official_goal_events
  where official_goal_events.match_result_id = p_match_result_id
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
           predictions.predicted_goalscorer_player_id, predictions.predicted_goal_minute,
           predictions.predicted_first_team_to_score, predictions.created_at
    from predictions
    where predictions.match_id = v_match_id
  loop
    v_scoreline_correct := (r_prediction.predicted_home_score = v_home_score and r_prediction.predicted_away_score = v_away_score);

    if r_prediction.predicted_goalscorer_player_id is null then
      v_goalscorer_correct := (v_official_goal_count = 0);
    else
      v_goalscorer_correct := exists (
        select 1 from official_goal_events
        where official_goal_events.match_result_id = p_match_result_id
          and official_goal_events.scorer_player_id = r_prediction.predicted_goalscorer_player_id
      );
    end if;

    if r_prediction.predicted_goal_minute is null then
      v_goal_minute_correct := (v_official_goal_count = 0);
    else
      v_goal_minute_correct := exists (
        select 1 from official_goal_events
        where official_goal_events.match_result_id = p_match_result_id
          and (official_goal_events.minute_regulation + coalesce(official_goal_events.minute_stoppage, 0)) = r_prediction.predicted_goal_minute
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

    insert into evaluations (
      prediction_id, match_result_id, scoreline_correct, goalscorer_correct,
      goal_minute_correct, first_team_to_score_correct, correct_dimension_count
    )
    values (
      r_prediction.prediction_id, p_match_result_id, v_scoreline_correct, v_goalscorer_correct,
      v_goal_minute_correct, v_first_team_correct, v_dimension_count
    )
    returning evaluations.evaluation_id into v_evaluation_id;

    v_performance_band_key := 'CORRECT_' || v_dimension_count || '_OF_4';

    select record_experience_summary_atomically.experience_summary_id into v_experience_summary_id
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
      v_evaluation_id::text,
      'predictions-v1',
      null,
      v_evaluation_id::text,
      jsonb_build_object(
        'correctDimensionCount', v_dimension_count,
        'scorelineCorrect', v_scoreline_correct,
        'goalscorerCorrect', v_goalscorer_correct,
        'goalMinuteCorrect', v_goal_minute_correct,
        'firstTeamCorrect', v_first_team_correct
      )
    );

    perform 1 from process_experience_summary_consequences_atomically(v_experience_summary_id);

    select prize_tiers.prize_tier_id into v_tier_id
    from prize_tiers
    where prize_tiers.venue_activation_id = r_prediction.venue_activation_id
      and prize_tiers.correct_dimension_count = v_dimension_count;

    if v_tier_id is not null then
      insert into prize_qualifications (
        evaluation_id, gaming_member_id, venue_activation_id, prize_tier_id
      )
      values (
        v_evaluation_id, r_prediction.gaming_member_id, r_prediction.venue_activation_id, v_tier_id
      );
    end if;
  end loop;

  return query select p_match_result_id, v_match_id, v_new_finalized_at, false;
end;
$$;
