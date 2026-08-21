import { describe, expect, it } from "vitest";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { finalizeMatchResult } from "../lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult } from "../lib/gaming/predictions/correctMatchResult";
import { redeemPrizeQualification } from "../lib/gaming/predictions/redeemPrizeQualification";
import {
  createTeam,
  createPlayer,
  setPlayerActive,
  createMatch,
  createVenue,
  createVenueActivation,
  createPrizeTier,
  saveDraftResult,
  startResultCorrection,
  setMatchActivityClassification,
} from "../lib/gaming/predictions/adminCatalog";
import {
  InvalidGoalscorerSelectionError,
  VenueActivationImmutableError,
  KickoffPassedError,
  GeoNotEligibleError,
  GeoUnavailableError,
  MatchCancelledError,
  QualificationSupersededError,
} from "../lib/gaming/predictions/types";
import { haversineDistanceMeters, evaluateGeoEligibility } from "../lib/gaming/predictions/geolocation";

const VENUE_LAT = 10.0;
const VENUE_LON = 10.0;
const INSIDE = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 };
const FAR_AWAY = { latitude: 40, longitude: 40, accuracyMeters: 5 };

function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function pastIso(ms = 3600_000): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * The minimal proving case throughout this suite: two Teams, each with
 * a two-Player roster, one Match, one Venue, one Activation. Mirrors
 * the founder's own Mbappé/Vini pairing example.
 */
async function setupMatchAndVenue(repo: InMemoryPredictionsRepository, kickoffAt = futureIso()) {
  const home = await createTeam(repo, { name: "Real Madrid" });
  const away = await createTeam(repo, { name: "Barcelona" });
  const mbappe = await createPlayer(repo, { teamId: home.teamId, name: "Mbappe" });
  const vini = await createPlayer(repo, { teamId: home.teamId, name: "Vini" });
  const lewa = await createPlayer(repo, { teamId: away.teamId, name: "Lewandowski" });
  const pedri = await createPlayer(repo, { teamId: away.teamId, name: "Pedri" });

  const match = await createMatch(repo, {
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    competition: "Friendly",
    kickoffAt,
  });
  // Persistent Metagame Phase 1: a Match must have a declared Activity
  // Classification before it can accept any Prediction. RANKED matches
  // the Phase 1 proving case default; fixture policy/rule rows are
  // seeded so finalize/correct (which now always attempt to resolve a
  // participation policy for any meaningfully-participating Prediction)
  // never hit an unconfigured-policy error in tests that don't care
  // about specific XP fixture values.
  await setMatchActivityClassification(repo, match.matchId, "RANKED");
  await repo.metagameRepository.createCategoryParticipationPolicy({
    categoryKey: "SOCCER_PREDICTIONS",
    dailyParticipationAllowance: 1000,
  });
  await repo.metagameRepository.createGamingXpRule({
    categoryKey: "SOCCER_PREDICTIONS",
    consequenceClass: "PARTICIPATION",
    performanceBandKey: null,
    points: 1,
  });
  const venue = await createVenue(repo, {
    name: "Test Venue",
    latitude: VENUE_LAT,
    longitude: VENUE_LON,
    radiusMeters: 100,
  });
  const activation = await createVenueActivation(repo, {
    matchId: match.matchId,
    venueId: venue.venueId,
  });
  return { home, away, mbappe, vini, lewa, pedri, match, venue, activation };
}

describe("Scoreline dimension", () => {
  it("exact scoreline match is correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 20, predictedFirstTeamToScore: "HOME",
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 2, awayScore: 1,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 20 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.scorelineCorrect).toBe(true);
  });

  it("a mismatched scoreline is incorrect even when the other three dimensions are correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 3, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 20, predictedFirstTeamToScore: "HOME",
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 2, awayScore: 1,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 20 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.scorelineCorrect).toBe(false);
    expect(evaluation!.goalscorerCorrect).toBe(true);
    expect(evaluation!.goalMinuteCorrect).toBe(true);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  });
});

describe("Goalscorer dimension", () => {
  it("the selected player scoring once is correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: null, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalscorerCorrect).toBe(true);
  });

  it("the selected player not scoring is incorrect", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe, vini } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: null, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: vini.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalscorerCorrect).toBe(false);
  });

  it("the selected player scoring twice (a brace) is still correct — not a multiset match", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: null, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 2, awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 10 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 60 },
      ],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalscorerCorrect).toBe(true);
  });

  it("No Goalscorer is correct on a 0-0 official result", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalscorerCorrect).toBe(true);
  });

  it("No Goalscorer is incorrect when the official match had a goal", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalscorerCorrect).toBe(false);
  });
});

describe("Goal Minute dimension", () => {
  it("a matching ordinary minute is correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: 67, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 67 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalMinuteCorrect).toBe(true);
  });

  it("an absent minute is incorrect", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: 30, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 67 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalMinuteCorrect).toBe(false);
  });

  it("stoppage-time minute (45+2) is compared by effective total elapsed minute", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: 47, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 45, minuteStoppage: 2 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalMinuteCorrect).toBe(true);
  });

  it("No Goal is correct only when the official match had zero goals", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalMinuteCorrect).toBe(true);
  });
});

describe("First Team to Score dimension", () => {
  it("the Home Team scoring first is correct when Home is predicted", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe, lewa } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: "HOME",
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 1,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 10 },
        { scorerPlayerId: lewa.playerId, minuteRegulation: 50 },
      ],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  });

  it("the Away Team scoring first is correct when Away is predicted, and ordering (not ordinal insertion) decides it", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe, lewa } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: "AWAY",
      geo: INSIDE,
    });
    // Inserted Home-first (ordinal 1) but Away's goal has the earlier
    // effective minute — chronological order must win over insertion
    // order.
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 1,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 50 },
        { scorerPlayerId: lewa.playerId, minuteRegulation: 10 },
      ],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  });

  it("No Goal is correct on a 0-0 official result", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  });

  it("an own goal credits the opposing Team, not the scorer's own Team", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, vini } = await setupMatchAndVenue(repo);
    // Vini plays for the Home Team (Real Madrid); an own goal by Vini
    // must credit AWAY (Barcelona) as the first-scoring Team.
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: "AWAY",
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 0, awayScore: 1,
      officialGoalEvents: [{ scorerPlayerId: vini.playerId, minuteRegulation: 30, isOwnGoal: true }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  });
});

describe("Independence of the four dimensions", () => {
  it("the founder's own example: Mbappe 20' + a Barcelona player 70', predicted as 2-1/Mbappe/70'/Barcelona-first", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe, lewa } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 70, predictedFirstTeamToScore: "AWAY",
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 2,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 20 },
        { scorerPlayerId: lewa.playerId, minuteRegulation: 70 },
      ],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    // Scoreline wrong (predicted 2-1, actual 1-2). Goalscorer correct
    // (Mbappe did score). Goal Minute correct (70' goal exists, scored
    // by someone else). First Team wrong (Mbappe/Real Madrid scored
    // first, not Barcelona) — four independent evaluations, not a
    // scorer-minute pairing.
    expect(evaluation!.scorelineCorrect).toBe(false);
    expect(evaluation!.goalscorerCorrect).toBe(true);
    expect(evaluation!.goalMinuteCorrect).toBe(true);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(false);
    expect(evaluation!.correctDimensionCount).toBe(2);
  });
});

describe("Roster validation", () => {
  it("a valid active player on either Match Team is accepted", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, lewa } = await setupMatchAndVenue(repo);
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 0, predictedAwayScore: 1,
        predictedGoalscorerPlayerId: lewa.playerId, predictedGoalMinute: 10, predictedFirstTeamToScore: "AWAY",
        geo: INSIDE,
      })
    ).resolves.toBeTruthy();
  });

  it("a player from neither Match Team is rejected", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    const otherTeam = await createTeam(repo, { name: "Bayern" });
    const outsider = await createPlayer(repo, { teamId: otherTeam.teamId, name: "Kane" });
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: outsider.playerId, predictedGoalMinute: 10, predictedFirstTeamToScore: "HOME",
        geo: INSIDE,
      })
    ).rejects.toBeInstanceOf(InvalidGoalscorerSelectionError);
  });

  it("an arbitrary/nonexistent player id is rejected", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: "does-not-exist", predictedGoalMinute: 10, predictedFirstTeamToScore: "HOME",
        geo: INSIDE,
      })
    ).rejects.toBeInstanceOf(InvalidGoalscorerSelectionError);
  });

  it("a deactivated player cannot be newly selected", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    await setPlayerActive(repo, mbappe.playerId, false);
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 10, predictedFirstTeamToScore: "HOME",
        geo: INSIDE,
      })
    ).rejects.toBeInstanceOf(InvalidGoalscorerSelectionError);
  });

  it("a player becoming inactive after settlement does not corrupt the historical Prediction or Evaluation", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 10, predictedFirstTeamToScore: "HOME",
      geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    await setPlayerActive(repo, mbappe.playerId, false);

    const stillReadable = await repo.getPredictionForMember(match.matchId, "gm-1");
    expect(stillReadable!.predictedGoalscorerPlayerId).toBe(mbappe.playerId);
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.goalscorerCorrect).toBe(true);
  });
});

describe("Prediction uniqueness — one per Match per Gaming Member, globally", () => {
  it("a second venue activation for the same match rejects with VenueActivationImmutableError", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    const venue2 = await createVenue(repo, { name: "Venue 2", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
    const activation2 = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue2.venueId });

    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null,
      geo: INSIDE,
    });

    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation2.venueActivationId,
        predictedHomeScore: 1, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null,
        geo: INSIDE,
      })
    ).rejects.toBeInstanceOf(VenueActivationImmutableError);
  });

  it("the same member may predict a different match freely", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match: matchA, activation: activationA, home, away } = await setupMatchAndVenue(repo);
    const matchB = await createMatch(repo, {
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Friendly", kickoffAt: futureIso(),
    });
    await setMatchActivityClassification(repo, matchB.matchId, "RANKED");
    const activationB = await createVenueActivation(repo, { matchId: matchB.matchId, venueId: activationA.venueId });

    await submitPrediction(repo, {
      matchId: matchA.matchId, gamingMemberId: "gm-1", venueActivationId: activationA.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    const predB = await submitPrediction(repo, {
      matchId: matchB.matchId, gamingMemberId: "gm-1", venueActivationId: activationB.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    expect(predB.matchId).toBe(matchB.matchId);
  });

  it("editing the same match through the same activation updates in place, not a second row", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const first = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 1, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    const second = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 2, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    expect(second.predictionId).toBe(first.predictionId);
    expect(second.predictedHomeScore).toBe(2);
    const all = await repo.listPredictionsForMatch(match.matchId);
    expect(all).toHaveLength(1);
  });
});

describe("Geolocation eligibility", () => {
  it("inside the radius is eligible", () => {
    const result = evaluateGeoEligibility(10.0001, 10.0001, 10, 10, 100);
    expect(result.eligible).toBe(true);
  });

  it("outside the radius is not eligible", () => {
    const result = evaluateGeoEligibility(40, 40, 10, 10, 100);
    expect(result.eligible).toBe(false);
  });

  it("submission with no reported position fails honestly, no fallback", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 0, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: null,
      })
    ).rejects.toBeInstanceOf(GeoUnavailableError);
  });

  it("a submission from outside the venue radius is rejected with GeoNotEligibleError", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 0, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: FAR_AWAY,
      })
    ).rejects.toBeInstanceOf(GeoNotEligibleError);
  });

  it("a revision re-verifies eligibility — cannot submit at the venue then edit from home", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: FAR_AWAY,
      })
    ).rejects.toBeInstanceOf(GeoNotEligibleError);
  });

  it("no raw coordinates are persisted on the resulting record", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    expect(Object.keys(prediction)).not.toContain("latitude");
    expect(Object.keys(prediction)).not.toContain("longitude");
    expect(prediction.measuredDistanceMeters).toBeGreaterThanOrEqual(0);
  });

  it("haversine distance between identical points is zero", () => {
    expect(haversineDistanceMeters(10, 10, 10, 10)).toBe(0);
  });
});

describe("Deadline enforcement — kickoff lock", () => {
  it("editing is permitted before kickoff", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo, futureIso(600_000));
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 0, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
      })
    ).resolves.toBeTruthy();
  });

  it("submission is rejected once kickoff has passed", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo, pastIso(1000));
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 0, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
      })
    ).rejects.toBeInstanceOf(KickoffPassedError);
  });

  it("a cancelled match rejects new predictions", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await repo.cancelMatch(match.matchId);
    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 0, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
      })
    ).rejects.toBeInstanceOf(MatchCancelledError);
  });
});

describe("Result draft / finalization boundary", () => {
  it("a draft has zero settlement effect", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 1, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 1 }],
      enteredByGamingMemberId: "gm-admin",
    });
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation).toBeNull();
  });

  it("finalize produces evaluations exactly once and is idempotent on retry", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: "gm-admin",
    });
    const first = await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    expect(first.alreadyFinalized).toBe(false);
    const second = await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    expect(second.alreadyFinalized).toBe(true);
    expect(second.finalizedAt).toBe(first.finalizedAt);
  });
});

describe("Result correction — supersession, compensation, no destroyed evidence", () => {
  it("a correction preserves the old evaluation and produces a new one against the corrected result", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe, vini } = await setupMatchAndVenue(repo);
    // Override setupMatchAndVenue's generic default (PARTICIPATION=1)
    // with this test's specific fixture values — later insertion wins.
    await repo.metagameRepository.createGamingXpRule({
      categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5,
    });
    await repo.metagameRepository.createGamingXpRule({
      categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100,
    });
    await repo.metagameRepository.createGamingXpRule({
      categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_3_OF_4", points: 10,
    });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 20, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });

    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 2, awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 20 },
        { scorerPlayerId: vini.playerId, minuteRegulation: 70 },
      ],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const oldEvaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(oldEvaluation!.correctDimensionCount).toBe(4);

    const correctionDraft = await startResultCorrection(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 20 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await correctMatchResult(repo, correctionDraft.matchResultId, "gm-admin");

    const stillOld = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(stillOld!.correctDimensionCount).toBe(4);

    const newEvaluation = await repo.getEvaluation(prediction.predictionId, correctionDraft.matchResultId);
    expect(newEvaluation!.correctDimensionCount).toBe(3);

    // gaming_progression_events (0061) receives no new writes as of
    // this phase — the canonical Gaming XP ledger is gaming_xp_events.
    expect(await repo.listProgressionEventsForMember("gm-1")).toHaveLength(0);

    const events = await repo.metagameRepository.listXpEventsForMember("gm-1");
    const netTotal = events.reduce((sum, e) => sum + e.points, 0);
    expect(netTotal).toBe(5 + 10);

    const reversal = events.find((e) => e.reversesGamingXpEventId !== null);
    expect(reversal).toBeDefined();
    expect(reversal!.points).toBe(-100);
    expect(reversal!.consequenceClass).toBe("PERFORMANCE");

    // Ordinary correctness correction preserves participation XP — it
    // is never reversed just because the score changed.
    const participationEvents = events.filter((e) => e.consequenceClass === "PARTICIPATION");
    expect(participationEvents).toHaveLength(1);
    expect(participationEvents[0].points).toBe(5);
  });

  it("a superseded qualification is never deleted; redemption history is preserved with the discrepancy visible", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe, vini } = await setupMatchAndVenue(repo);
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 3, prizeLabel: "Sticker" });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 20, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 2, awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 20 },
        { scorerPlayerId: vini.playerId, minuteRegulation: 70 },
      ],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");

    const oldEvaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    const oldQualification = await repo.getQualificationForEvaluation(oldEvaluation!.evaluationId);
    expect(oldQualification).not.toBeNull();

    await redeemPrizeQualification(repo, oldQualification!.prizeQualificationId, "gm-admin");

    const correctionDraft = await startResultCorrection(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 20 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await correctMatchResult(repo, correctionDraft.matchResultId, "gm-admin");

    const stillThere = await repo.getQualificationForEvaluation(oldEvaluation!.evaluationId);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.redeemedAt).not.toBeNull();
    expect(stillThere!.supersededAt).not.toBeNull();

    const newEvaluation = await repo.getEvaluation(prediction.predictionId, correctionDraft.matchResultId);
    const newQualification = await repo.getQualificationForEvaluation(newEvaluation!.evaluationId);
    expect(newQualification).not.toBeNull();
    expect(newQualification!.redeemedAt).toBeNull();
  });
});

describe("Gaming XP (progression events)", () => {
  it("participation and performance both fire and stack when configured to", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await repo.metagameRepository.createGamingXpRule({
      categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5,
    });
    await repo.metagameRepository.createGamingXpRule({
      categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100,
    });
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, { matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: "gm-admin" });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const events = await repo.metagameRepository.listXpEventsForMember("gm-1");
    expect(events.reduce((s, e) => s + e.points, 0)).toBe(105);
    expect(events.map((e) => e.consequenceClass).sort()).toEqual(["PARTICIPATION", "PERFORMANCE"]);
  });

  it("venue-hopping cannot create duplicate progression — only one prediction, one evaluation, ever exists per member per match", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, { matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: "gm-admin" });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");

    expect(await repo.listPredictionsForMatch(match.matchId)).toHaveLength(1);

    const events = await repo.metagameRepository.listXpEventsForMember("gm-1");
    const distinctSummaryIds = new Set(events.map((e) => e.experienceSummaryId));
    expect(distinctSummaryIds.size).toBe(1);
  });

  it("gaming_progression_events (0061) receives no new writes — the canonical ledger is gaming_xp_events", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-alex", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 1, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 1 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    expect(await repo.listProgressionEventsForMember("gm-alex")).toHaveLength(0);
    const events = await repo.metagameRepository.listXpEventsForMember("gm-alex");
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("Prize tiers and qualification", () => {
  it("a configured tier produces a qualification", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, { matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: "gm-admin" });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(qualification).not.toBeNull();
    expect(qualification!.prizeTierId).toBeTruthy();
  });

  it("an absent 2/4 tier produces no qualification and no error", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 3, prizeLabel: "Cap" });
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 1, prizeLabel: "Sticker" });
    // Scoreline correct, Goalscorer correct, Goal Minute wrong, First
    // Team wrong — a genuine, deliberately-constructed 2/4.
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 5, predictedFirstTeamToScore: "AWAY", geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 80 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(evaluation!.correctDimensionCount).toBe(2);
    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(qualification).toBeNull();
  });

  it("redemption is exactly once and idempotent on retry", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupMatchAndVenue(repo);
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, { matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: "gm-admin" });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);

    const first = await redeemPrizeQualification(repo, qualification!.prizeQualificationId, "gm-admin");
    expect(first.alreadyRedeemed).toBe(false);
    const second = await redeemPrizeQualification(repo, qualification!.prizeQualificationId, "gm-admin");
    expect(second.alreadyRedeemed).toBe(true);
    expect(second.redeemedAt).toBe(first.redeemedAt);
  });

  it("a superseded, never-redeemed qualification cannot be newly redeemed", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe, vini } = await setupMatchAndVenue(repo);
    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 20, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 2, awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 20 },
        { scorerPlayerId: vini.playerId, minuteRegulation: 70 },
      ],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const oldEvaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    const oldQualification = await repo.getQualificationForEvaluation(oldEvaluation!.evaluationId);

    const correctionDraft = await startResultCorrection(repo, {
      matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: "gm-admin",
    });
    await correctMatchResult(repo, correctionDraft.matchResultId, "gm-admin");

    await expect(
      redeemPrizeQualification(repo, oldQualification!.prizeQualificationId, "gm-admin")
    ).rejects.toBeInstanceOf(QualificationSupersededError);
  });
});

describe("Ownership / privacy", () => {
  it("getPredictionForMember never returns another member's prediction", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, mbappe } = await setupMatchAndVenue(repo);
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-alex", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinute: 1, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    const jordanView = await repo.getPredictionForMember(match.matchId, "gm-jordan");
    expect(jordanView).toBeNull();
  });
});
