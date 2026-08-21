import type { PredictionsRepository } from "./db/predictionsRepository";
import type {
  TeamRecord,
  PlayerRecord,
  MatchRecord,
  VenueRecord,
  VenueActivationRecord,
  PrizeTierRecord,
  MatchResultRecord,
  OfficialGoalEventInput,
} from "./types";
import {
  InvalidPrizeTierDimensionCountError,
  DraftResultAlreadyExistsError,
  NoFinalizedResultToCorrectError,
  ResultAlreadyBeingCorrectedError,
} from "./types";

/**
 * The smallest founder/admin catalog surface: Team/Player roster,
 * Match, Venue, Venue Activation, Prize Tier CRUD, and draft Result
 * entry (both first-time and correction). Grouped in one file — none
 * of these carry the concurrency/invariant weight that earns a
 * dedicated atomic function (see finalizeMatchResult.ts /
 * correctMatchResult.ts for the two that do) — plain repository
 * operations, matching this codebase's own "not every insert needs to
 * be an RPC" precedent (e.g. prepareQuestions). Admin authority itself
 * is checked by the caller (the API route), via lib/gaming/auth.ts's
 * isCurrentlyGamingAdmin — never here.
 *
 * Roster is deliberately the smallest v1 capability: no league
 * management, no sports-data-provider integration. A future provider
 * may automate Team/Player/Match population; this manual admin
 * workflow is the v1 source of truth either way, and every id here is
 * this domain's own stable internal id — a future provider's own ids
 * would map into these, never replace them.
 */

export async function createTeam(
  repo: PredictionsRepository,
  input: { name: string }
): Promise<TeamRecord> {
  return repo.createTeam({ name: input.name.trim() });
}

export async function listTeams(repo: PredictionsRepository): Promise<TeamRecord[]> {
  return repo.listTeams();
}

/** active defaults true — deactivation (never deletion) is how a Player stops being selectable. */
export async function createPlayer(
  repo: PredictionsRepository,
  input: { teamId: string; name: string }
): Promise<PlayerRecord> {
  return repo.createPlayer({ teamId: input.teamId, name: input.name.trim() });
}

export async function editPlayer(
  repo: PredictionsRepository,
  playerId: string,
  input: { name: string }
): Promise<PlayerRecord> {
  return repo.editPlayer(playerId, { name: input.name.trim() });
}

export async function setPlayerActive(
  repo: PredictionsRepository,
  playerId: string,
  active: boolean
): Promise<PlayerRecord> {
  return repo.setPlayerActive(playerId, active);
}

export async function listPlayersForTeam(
  repo: PredictionsRepository,
  teamId: string
): Promise<PlayerRecord[]> {
  return repo.listPlayersForTeam(teamId);
}

export async function createMatch(
  repo: PredictionsRepository,
  input: { homeTeamId: string; awayTeamId: string; competition: string; kickoffAt: string }
): Promise<MatchRecord> {
  return repo.createMatch({
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    competition: input.competition.trim(),
    kickoffAt: input.kickoffAt,
  });
}

export async function editMatch(
  repo: PredictionsRepository,
  matchId: string,
  input: { homeTeamId: string; awayTeamId: string; competition: string; kickoffAt: string }
): Promise<MatchRecord> {
  return repo.editMatch(matchId, {
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    competition: input.competition.trim(),
    kickoffAt: input.kickoffAt,
  });
}

export async function cancelMatch(
  repo: PredictionsRepository,
  matchId: string
): Promise<MatchRecord> {
  return repo.cancelMatch(matchId);
}

const ACTIVITY_CLASSIFICATIONS = ["TRAINING", "CASUAL", "RANKED", "OFFICIAL"] as const;
type ActivityClassificationInput = (typeof ACTIVITY_CLASSIFICATIONS)[number];

/**
 * SET_MATCH_ACTIVITY_CLASSIFICATION — declares (or re-declares, while
 * still free to change) the Match-level Activity Classification a
 * Prediction on it will be recognized under. Must be called before
 * any Prediction can be submitted (enforced inside
 * upsert_prediction_atomically); becomes immutable the moment
 * Prediction or Result evidence exists (enforced inside
 * set_match_activity_classification_atomically itself). This is a
 * Predictions-owned concept — Venue Activation never owns it.
 */
export async function setMatchActivityClassification(
  repo: PredictionsRepository,
  matchId: string,
  activityClassification: string
): Promise<{ matchId: string; activityClassification: string; locked: boolean }> {
  if (!ACTIVITY_CLASSIFICATIONS.includes(activityClassification as ActivityClassificationInput)) {
    throw new Error("activityClassification must be one of TRAINING, CASUAL, RANKED, OFFICIAL.");
  }
  return repo.setMatchActivityClassification(matchId, activityClassification as ActivityClassificationInput);
}

export async function createVenue(
  repo: PredictionsRepository,
  input: { name: string; latitude: number; longitude: number; radiusMeters: number }
): Promise<VenueRecord> {
  return repo.createVenue({ ...input, name: input.name.trim() });
}

export async function editVenue(
  repo: PredictionsRepository,
  venueId: string,
  input: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    active: boolean;
  }
): Promise<VenueRecord> {
  return repo.editVenue(venueId, { ...input, name: input.name.trim() });
}

export async function createVenueActivation(
  repo: PredictionsRepository,
  input: { matchId: string; venueId: string }
): Promise<VenueActivationRecord> {
  return repo.createVenueActivation(input);
}

export async function setVenueActivationEnabled(
  repo: PredictionsRepository,
  venueActivationId: string,
  enabled: boolean
): Promise<VenueActivationRecord> {
  return repo.setVenueActivationEnabled(venueActivationId, enabled);
}

export async function createPrizeTier(
  repo: PredictionsRepository,
  input: { venueActivationId: string; correctDimensionCount: number; prizeLabel: string }
): Promise<PrizeTierRecord> {
  if (
    !Number.isInteger(input.correctDimensionCount) ||
    input.correctDimensionCount < 1 ||
    input.correctDimensionCount > 4
  ) {
    throw new InvalidPrizeTierDimensionCountError();
  }
  return repo.createPrizeTier({ ...input, prizeLabel: input.prizeLabel.trim() });
}

/** First-time draft entry: creates or edits the Match's one un-finalized draft. */
export async function saveDraftResult(
  repo: PredictionsRepository,
  input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
  }
): Promise<MatchResultRecord> {
  const currentFinalized = await repo.getCurrentFinalizedMatchResult(input.matchId);
  if (currentFinalized) {
    // A finalized result already exists — this must go through
    // startResultCorrection, not a plain first-time draft save.
    throw new DraftResultAlreadyExistsError();
  }
  return repo.saveDraftMatchResult({
    ...input,
    supersedesMatchResultId: null,
  });
}

/** Starts (or edits) a correction draft against the Match's current finalized Result. */
export async function startResultCorrection(
  repo: PredictionsRepository,
  input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
  }
): Promise<MatchResultRecord> {
  const currentFinalized = await repo.getCurrentFinalizedMatchResult(input.matchId);
  if (!currentFinalized) {
    throw new NoFinalizedResultToCorrectError();
  }

  const existingDraft = await repo.getDraftMatchResult(input.matchId);
  if (existingDraft && existingDraft.supersedesMatchResultId !== currentFinalized.matchResultId) {
    throw new ResultAlreadyBeingCorrectedError();
  }

  return repo.saveDraftMatchResult({
    ...input,
    supersedesMatchResultId: currentFinalized.matchResultId,
  });
}
