-- Migration: 0098_finalize_match_result_atomically_predictions_v2
-- Soccer Predictions v2. 0091's own finalize_match_result_atomically is
-- not edited as a file — drop-then-recreate, same precedent as every
-- prior replacement of this function.
--
-- Behavioral changes, all landing together as one coherent
-- ruleset_version generation ('predictions-v2'):
--
-- 1. Cancelled/abandoned Match guard: matches.cancelled_at is checked
--    immediately after resolving the Match, before any Evaluation,
--    Summary, or Prize Qualification work begins. A cancelled Match
--    (the same single field already used to block new Predictions in
--    upsert_prediction_atomically, whether the cancellation happened
--    before kickoff or after — cancelMatch has no timing precondition
--    and needed none added) must never produce a finalized
--    competitive settlement. Raises MATCH_CANCELLED, reusing the
--    identical error string upsert_prediction_atomically already
--    uses, for one consistent client-facing error across both
--    boundaries of the same rule.
--
-- 2. Regulation-time eligibility predicate, applied identically
--    everywhere official_goal_events is consulted: an event is
--    REGULATION-TIME ELIGIBLE for Predictions settlement purposes iff
--    minute_regulation BETWEEN 1 AND 90. This single predicate
--    correctly includes first-half stoppage (minute_regulation = 45,
--    any stoppage offset) and second-half stoppage (minute_regulation
--    = 90, any stoppage offset) — both are still within 1-90 — while
--    excluding every extra-time event (minute_regulation 91-120) from
--    all four Prediction dimensions, without removing extra-time
--    events from the official record itself (official_goal_events'
--    own 1-120 range and unconstrained stoppage remain untouched by
--    this migration — only how Predictions *reads* that evidence
--    changes). Applied to: the total eligible goal count driving
--    No-Goal/No-Goalscorer/No-Team determination; the Goalscorer
--    existence check; the Goal-Minute existence check; and the
--    chronologically-first-goal derivation for First Team to Score.
--    An extra-time-only match therefore still correctly settles a
--    "No Goal"/"No Goalscorer"/"No Team" prediction as correct, since
--    zero *eligible* goals occurred, exactly as required.
--
-- 3. Any Goalscorer excludes own goals: the existence check now also
--    requires NOT official_goal_events.is_own_goal. Any Goal Minute
--    is intentionally NOT given the same exclusion — an own goal is
--    still a real, legitimate goal event at its own effective moment,
--    so it continues to satisfy a matching Goal-Minute prediction
--    (unchanged from 0091). First Team to Score's own-goal handling
--    (crediting the opposing/receiving side) is also unchanged.
--
-- 4. Goal Minute comparison is now structural, not arithmetic: an
--    eligible official event matches a Prediction iff
--    official_goal_events.minute_regulation = predicted_goal_minute_regulation
--    AND official_goal_events.minute_stoppage IS NOT DISTINCT FROM
--    predicted_goal_minute_stoppage (null-safe, since both sides use
--    null to mean "no stoppage"). Never a summed comparison — this is
--    the exact fix for the 45+10-collides-with-ordinary-55 defect
--    identified in 0056's own (now-corrected) governing comment.
--
-- 5. ruleset_version bumps to 'predictions-v2', identifying this
--    entire coherent bundle of changes together — no per-dimension
--    versioning, no rules engine.
--
-- 6. correct_dimension_keys is now authored alongside
--    correct_dimension_count, in the fixed canonical order
--    EXACT_SCORELINE, ANY_GOALSCORER, ANY_GOAL_MINUTE,
--    FIRST_TEAM_TO_SCORE — a Predictions-adapter invariant (this
--    function is the construction site), never a shared
--    experience_summaries-table constraint (0095's own comment).
--
-- Unchanged from 0091: Exact Scoreline itself remains a direct
-- home_score/away_score comparison — the schema still cannot
-- structurally prove an admin entered a regulation-time-only score
-- rather than one inclusive of extra time or a shootout outcome; this
-- migration does not invent new evidentiary infrastructure to close
-- that gap (explicitly out of scope), and the comparison itself is
-- otherwise byte-for-byte unchanged. Prize Qualification logic is
-- also byte-for-byte unchanged.

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
  v_cancelled_at timestamptz;
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
  v_dimension_keys text[];
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

  select matches.cancelled_at into v_cancelled_at
  from matches
  where matches.match_id = v_match_id;

  if v_cancelled_at is not null then
    raise exception 'MATCH_CANCELLED: this match has been cancelled'
      using errcode = 'P0001';
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
      'predictions-v2',
      null,
      v_evaluation_id::text,
      jsonb_build_object(
        'correctDimensionCount', v_dimension_count,
        'scorelineCorrect', v_scoreline_correct,
        'goalscorerCorrect', v_goalscorer_correct,
        'goalMinuteCorrect', v_goal_minute_correct,
        'firstTeamCorrect', v_first_team_correct
      ),
      v_dimension_count,
      v_dimension_keys
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
