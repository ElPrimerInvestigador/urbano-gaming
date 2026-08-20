-- Migration: 0063_create_upsert_prediction_atomically
-- Soccer Predictions — corrected model. The single write path for
-- both a first-time Prediction and every revision before kickoff.
-- Every check runs on every call: a member cannot submit once at a
-- Venue and continue editing from home, since geolocation eligibility
-- is re-verified on every save.
--
-- Ordered checks: Match exists and is not cancelled; kickoff has not
-- passed (row-locked on matches); Venue Activation exists, belongs to
-- this Match, and is enabled; geo eligibility (computed by the
-- caller, re-verified true here); score non-negativity; the selected
-- Goalscorer (if any) is an active Player on one of this Match's two
-- Teams — the goal-count invariant from the superseded design is
-- gone entirely, replaced by this single roster-membership check.
--
-- venue_activation_id immutability: unchanged — an existing
-- Prediction is located by (match_id, gaming_member_id), and a
-- differing p_venue_activation_id is rejected outright.

create function upsert_prediction_atomically(
  p_match_id uuid,
  p_gaming_member_id uuid,
  p_venue_activation_id uuid,
  p_predicted_home_score integer,
  p_predicted_away_score integer,
  p_predicted_goalscorer_player_id uuid,
  p_predicted_goal_minute integer,
  p_predicted_first_team_to_score text,
  p_geo_verified_at timestamptz,
  p_measured_distance_meters numeric,
  p_reported_accuracy_meters numeric,
  p_geo_eligible boolean
)
returns table (
  prediction_id uuid,
  match_id uuid,
  gaming_member_id uuid,
  venue_activation_id uuid,
  predicted_home_score integer,
  predicted_away_score integer,
  predicted_goalscorer_player_id uuid,
  predicted_goal_minute integer,
  predicted_first_team_to_score text,
  geo_verified_at timestamptz,
  measured_distance_meters numeric,
  reported_accuracy_meters numeric,
  geo_eligible boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_kickoff_at timestamptz;
  v_cancelled_at timestamptz;
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_activation_match_id uuid;
  v_activation_enabled boolean;
  v_existing_id uuid;
  v_existing_venue_activation_id uuid;
  v_goalscorer_team_id uuid;
  v_goalscorer_active boolean;
begin
  select matches.kickoff_at, matches.cancelled_at, matches.home_team_id, matches.away_team_id
    into v_kickoff_at, v_cancelled_at, v_home_team_id, v_away_team_id
  from matches
  where matches.match_id = p_match_id
  for update;

  if v_kickoff_at is null then
    raise exception 'MATCH_NOT_FOUND: no match exists for this match_id'
      using errcode = 'P0001';
  end if;

  if v_cancelled_at is not null then
    raise exception 'MATCH_CANCELLED: this match has been cancelled'
      using errcode = 'P0001';
  end if;

  if now() >= v_kickoff_at then
    raise exception 'KICKOFF_PASSED: predictions are locked for this match'
      using errcode = 'P0001';
  end if;

  select venue_activations.match_id, venue_activations.enabled
    into v_activation_match_id, v_activation_enabled
  from venue_activations
  where venue_activations.venue_activation_id = p_venue_activation_id;

  if v_activation_match_id is null then
    raise exception 'VENUE_ACTIVATION_NOT_FOUND: no venue activation exists for this id'
      using errcode = 'P0001';
  end if;

  if v_activation_match_id <> p_match_id then
    raise exception 'VENUE_ACTIVATION_MATCH_MISMATCH: this venue activation is not for the supplied match'
      using errcode = 'P0001';
  end if;

  if not v_activation_enabled then
    raise exception 'VENUE_ACTIVATION_DISABLED: this venue activation is not currently enabled'
      using errcode = 'P0001';
  end if;

  if not p_geo_eligible then
    raise exception 'GEO_NOT_ELIGIBLE: submission failed geolocation eligibility'
      using errcode = 'P0001';
  end if;

  if p_predicted_home_score < 0 or p_predicted_away_score < 0 then
    raise exception 'INVALID_SCORE: predicted scores must be non-negative'
      using errcode = 'P0001';
  end if;

  if p_predicted_goal_minute is not null and (p_predicted_goal_minute < 1 or p_predicted_goal_minute > 120) then
    raise exception 'INVALID_GOAL_MINUTE: predicted goal minute must be between 1 and 120'
      using errcode = 'P0001';
  end if;

  if p_predicted_first_team_to_score is not null and p_predicted_first_team_to_score not in ('HOME', 'AWAY') then
    raise exception 'INVALID_FIRST_TEAM: predicted first team to score must be HOME, AWAY, or null'
      using errcode = 'P0001';
  end if;

  if p_predicted_goalscorer_player_id is not null then
    select players.team_id, players.active into v_goalscorer_team_id, v_goalscorer_active
    from players
    where players.player_id = p_predicted_goalscorer_player_id;

    if v_goalscorer_team_id is null then
      raise exception 'INVALID_GOALSCORER_SELECTION: no player exists for this id'
        using errcode = 'P0001';
    end if;

    if v_goalscorer_team_id <> v_home_team_id and v_goalscorer_team_id <> v_away_team_id then
      raise exception 'INVALID_GOALSCORER_SELECTION: this player does not belong to either team in this match'
        using errcode = 'P0001';
    end if;

    if not v_goalscorer_active then
      raise exception 'INVALID_GOALSCORER_SELECTION: this player is not currently selectable'
        using errcode = 'P0001';
    end if;
  end if;

  select predictions.prediction_id, predictions.venue_activation_id
    into v_existing_id, v_existing_venue_activation_id
  from predictions
  where predictions.match_id = p_match_id
    and predictions.gaming_member_id = p_gaming_member_id
  for update;

  if v_existing_id is not null and v_existing_venue_activation_id <> p_venue_activation_id then
    raise exception 'VENUE_ACTIVATION_IMMUTABLE: this prediction was first submitted through a different venue activation'
      using errcode = 'P0001';
  end if;

  if v_existing_id is null then
    insert into predictions (
      match_id, gaming_member_id, venue_activation_id,
      predicted_home_score, predicted_away_score,
      predicted_goalscorer_player_id, predicted_goal_minute, predicted_first_team_to_score,
      geo_verified_at, measured_distance_meters, reported_accuracy_meters, geo_eligible
    )
    values (
      p_match_id, p_gaming_member_id, p_venue_activation_id,
      p_predicted_home_score, p_predicted_away_score,
      p_predicted_goalscorer_player_id, p_predicted_goal_minute, p_predicted_first_team_to_score,
      p_geo_verified_at, p_measured_distance_meters, p_reported_accuracy_meters, p_geo_eligible
    )
    returning predictions.prediction_id into v_existing_id;
  else
    update predictions set
      predicted_home_score = p_predicted_home_score,
      predicted_away_score = p_predicted_away_score,
      predicted_goalscorer_player_id = p_predicted_goalscorer_player_id,
      predicted_goal_minute = p_predicted_goal_minute,
      predicted_first_team_to_score = p_predicted_first_team_to_score,
      geo_verified_at = p_geo_verified_at,
      measured_distance_meters = p_measured_distance_meters,
      reported_accuracy_meters = p_reported_accuracy_meters,
      geo_eligible = p_geo_eligible,
      updated_at = now()
    where predictions.prediction_id = v_existing_id;
  end if;

  return query
    select predictions.prediction_id, predictions.match_id, predictions.gaming_member_id,
           predictions.venue_activation_id, predictions.predicted_home_score, predictions.predicted_away_score,
           predictions.predicted_goalscorer_player_id, predictions.predicted_goal_minute,
           predictions.predicted_first_team_to_score, predictions.geo_verified_at,
           predictions.measured_distance_meters, predictions.reported_accuracy_meters, predictions.geo_eligible,
           predictions.created_at, predictions.updated_at
    from predictions
    where predictions.prediction_id = v_existing_id;
end;
$$;
