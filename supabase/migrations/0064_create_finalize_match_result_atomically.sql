-- Migration: 0064_create_finalize_match_result_atomically
-- Soccer Predictions — corrected model. The authoritative settlement
-- boundary for a Match's first Result. Draft entry (creating/editing
-- an un-finalized match_results row and its official_goal_events) is
-- plain repository CRUD with zero settlement effect.
--
-- Idempotent: an already-finalized p_match_result_id returns the
-- existing finalized_at with already_finalized = true, no further
-- work — mirrors CLOSE_QUIZ's own alreadyClosed precedent.
--
-- Two official facts are computed once per Result Version, not per
-- Prediction: the total official goal count (used by both Goalscorer
-- and Goal Minute's own "No Goal" branch) and the chronologically
-- first goal's credited Team (HOME/AWAY/NO_GOAL) — an own goal credits
-- the *opposing* Team on the scoreline, computed from is_own_goal +
-- the scorer's own Team vs. the Match's home/away Team ids, never
-- stored redundantly. Each Prediction's four dimensions are then
-- evaluated entirely independently against these facts and the raw
-- official_goal_events rows — no scorer-minute pairing, no hidden
-- Outcome dimension.

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

  select matches.home_team_id, matches.away_team_id
    into v_home_team_id, v_away_team_id
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
           predictions.predicted_first_team_to_score
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

    insert into gaming_progression_events (
      gaming_member_id, rule_key, points, match_id, evaluation_id, idempotency_key
    )
    select r_prediction.gaming_member_id, 'PREDICTION_PARTICIPATED', progression_rule_points.points,
           v_match_id, v_evaluation_id, v_evaluation_id::text || ':PREDICTION_PARTICIPATED'
    from progression_rule_points
    where progression_rule_points.rule_key = 'PREDICTION_PARTICIPATED'
    on conflict (gaming_member_id, idempotency_key) do nothing;

    if v_dimension_count > 0 then
      insert into gaming_progression_events (
        gaming_member_id, rule_key, points, match_id, evaluation_id, idempotency_key
      )
      select r_prediction.gaming_member_id, 'PREDICTION_' || v_dimension_count || '_OF_4', progression_rule_points.points,
             v_match_id, v_evaluation_id, v_evaluation_id::text || ':PREDICTION_' || v_dimension_count || '_OF_4'
      from progression_rule_points
      where progression_rule_points.rule_key = 'PREDICTION_' || v_dimension_count || '_OF_4'
      on conflict (gaming_member_id, idempotency_key) do nothing;
    end if;

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
