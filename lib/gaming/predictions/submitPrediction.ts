import type { PredictionsRepository } from "./db/predictionsRepository";
import type { PredictionRecord, GeoSubmission } from "./types";
import { VenueActivationNotFoundError, GeoUnavailableError } from "./types";
import { evaluateGeoEligibility } from "./geolocation";

/**
 * SUBMIT_PREDICTION — the single write path for both a first-time
 * Prediction and every revision before kickoff. Geolocation eligibility
 * is recomputed here from the venue's own coordinates on every call
 * (never cached from a prior submission), then handed to
 * upsert_prediction_atomically as pre-computed evidence — the atomic
 * function re-checks geoEligible is true rather than trusting it
 * blindly, but the actual distance computation happens here, once,
 * against the specific Venue this Activation belongs to.
 *
 * The four Prediction dimensions are independent: predictedGoalscorer-
 * PlayerId, predictedGoalMinuteRegulation/predictedGoalMinuteStoppage,
 * and predictedFirstTeamToScore are each passed through untouched (a
 * player id, a (regulation, stoppage) integer pair, and an enum — none
 * need normalization) and each nullable, with null meaning the member
 * deliberately chose "No Goal" for that dimension. Roster membership/
 * activity validation and Goal-Minute shape validation both happen
 * inside upsert_prediction_atomically itself, not here.
 *
 * geo === null (no reported position at all — permission denied, or
 * the browser could not produce a fix) fails honestly with
 * GeoUnavailableError; there is no IP-geolocation or other fallback.
 */
export async function submitPrediction(
  repo: PredictionsRepository,
  input: {
    matchId: string;
    gamingMemberId: string;
    venueActivationId: string;
    predictedHomeScore: number;
    predictedAwayScore: number;
    predictedGoalscorerPlayerId: string | null;
    predictedGoalMinuteRegulation: number | null;
    predictedGoalMinuteStoppage: number | null;
    predictedFirstTeamToScore: "HOME" | "AWAY" | null;
    geo: GeoSubmission | null;
  }
): Promise<PredictionRecord> {
  if (!input.geo) {
    throw new GeoUnavailableError();
  }

  const activation = await repo.getVenueActivationById(input.venueActivationId);
  if (!activation) {
    throw new VenueActivationNotFoundError();
  }
  const venue = await repo.getVenueById(activation.venueId);
  if (!venue) {
    throw new VenueActivationNotFoundError();
  }

  const geoResult = evaluateGeoEligibility(
    input.geo.latitude,
    input.geo.longitude,
    venue.latitude,
    venue.longitude,
    venue.radiusMeters
  );

  return repo.upsertPrediction({
    matchId: input.matchId,
    gamingMemberId: input.gamingMemberId,
    venueActivationId: input.venueActivationId,
    predictedHomeScore: input.predictedHomeScore,
    predictedAwayScore: input.predictedAwayScore,
    predictedGoalscorerPlayerId: input.predictedGoalscorerPlayerId,
    predictedGoalMinuteRegulation: input.predictedGoalMinuteRegulation,
    predictedGoalMinuteStoppage: input.predictedGoalMinuteStoppage,
    predictedFirstTeamToScore: input.predictedFirstTeamToScore,
    geoVerifiedAt: new Date().toISOString(),
    measuredDistanceMeters: geoResult.measuredDistanceMeters,
    reportedAccuracyMeters: input.geo.accuracyMeters,
    geoEligible: geoResult.eligible,
  });
}
