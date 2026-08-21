import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";

import { InMemoryMetagameRepository } from "../lib/gaming/metagame/db/inMemoryMetagameRepository";
import { recordExperienceSummary } from "../lib/gaming/metagame/recordExperienceSummary";
import { processExperienceSummaryConsequences } from "../lib/gaming/metagame/processExperienceSummaryConsequences";
import { ExperienceSummaryNotFoundError } from "../lib/gaming/metagame/types";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { finalizeMatchResult } from "../lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult } from "../lib/gaming/predictions/correctMatchResult";
import {
  createTeam,
  createPlayer,
  createMatch,
  createVenue,
  createVenueActivation,
  createPrizeTier,
  saveDraftResult,
  startResultCorrection,
  setMatchActivityClassification,
} from "../lib/gaming/predictions/adminCatalog";
import { MatchNotClassifiedError, ActivityClassificationLockedError } from "../lib/gaming/predictions/types";

const VENUE_LAT = 10.0;
const VENUE_LON = 10.0;
const INSIDE = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 };

function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

async function setupRankedMatch(repo: InMemoryPredictionsRepository, kickoffAt = futureIso()) {
  const home = await createTeam(repo, { name: "Home FC" });
  const away = await createTeam(repo, { name: "Away FC" });
  const striker = await createPlayer(repo, { teamId: home.teamId, name: "Striker" });
  const match = await createMatch(repo, { homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Test Cup", kickoffAt });
  await setMatchActivityClassification(repo, match.matchId, "RANKED");
  await repo.metagameRepository.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 1000 });
  await repo.metagameRepository.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
  const venue = await createVenue(repo, { name: "Test Venue", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
  const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
  return { home, away, striker, match, venue, activation };
}

// Deliberately configures NO category participation policy and NO XP
// rules at all — proves the missing-policy boundary correction via
// the real Predictions finalize path, not just direct Metagame calls.
async function setupRankedMatchNoXpConfig(repo: InMemoryPredictionsRepository, kickoffAt = futureIso()) {
  const home = await createTeam(repo, { name: "Home FC" });
  const away = await createTeam(repo, { name: "Away FC" });
  const striker = await createPlayer(repo, { teamId: home.teamId, name: "Striker" });
  const match = await createMatch(repo, { homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Test Cup", kickoffAt });
  await setMatchActivityClassification(repo, match.matchId, "RANKED");
  const venue = await createVenue(repo, { name: "Test Venue", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
  const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
  return { home, away, striker, match, venue, activation };
}

// --- SUMMARY ---------------------------------------------------------

describe("Finalized Experience Summary — authorship and idempotency", () => {
  it("is idempotent per (experienceKey, idempotencyKey) — a retried record returns the same summary", async () => {
    const repo = new InMemoryMetagameRepository();
    const input = {
      gamingMemberId: randomUUID(),
      experienceKey: "SOCCER_PREDICTIONS",
      categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED" as const,
      authorityTier: "ADMIN_FINALIZED" as const,
      occurredAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true,
      performanceBandKey: null,
      sourceReference: "eval-1",
      rulesetVersion: "v1",
      supersedesExperienceSummaryId: null,
      idempotencyKey: "eval-1",
      evidence: {},
    };
    const first = await recordExperienceSummary(repo, input);
    const second = await recordExperienceSummary(repo, input);
    expect(second.experienceSummaryId).toBe(first.experienceSummaryId);
    expect(first.alreadyRecorded).toBe(false);
    expect(second.alreadyRecorded).toBe(true);
  });

  it("processing consequences for an unknown summary id throws ExperienceSummaryNotFoundError", async () => {
    const repo = new InMemoryMetagameRepository();
    await expect(processExperienceSummaryConsequences(repo, randomUUID())).rejects.toBeInstanceOf(
      ExperienceSummaryNotFoundError
    );
  });

  it("Soccer Predictions: occurred_at is the first accepted Prediction's own created_at, never moved by a later pre-kickoff revision", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, striker } = await setupRankedMatch(repo);
    const gamingMemberId = "gm-1";

    const first = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    const revised = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: striker.playerId, predictedGoalMinute: 10, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    expect(revised.predictionId).toBe(first.predictionId);
    expect(revised.createdAt).toBe(first.createdAt);

    const draft = await saveDraftResult(repo, { matchId: match.matchId, homeScore: 2, awayScore: 1, officialGoalEvents: [{ scorerPlayerId: striker.playerId, minuteRegulation: 10 }], enteredByGamingMemberId: "gm-admin" });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");

    const events = await repo.metagameRepository.listXpEventsForMember(gamingMemberId);
    const summary = await repo.metagameRepository.getExperienceSummary(events[0].experienceSummaryId);
    // occurred_at is anchored to the FIRST accepted submission, not the
    // later revision — asserted directly rather than via inequality
    // against revised.updatedAt, which can coincide at millisecond
    // resolution when both happen back-to-back in a fast test run.
    expect(summary!.occurredAt).toBe(first.createdAt);
    expect(summary!.performanceBandKey).toBe("CORRECT_4_OF_4"); // the LATEST predicted content is what's evaluated
  });
});

// --- CLASSIFICATION ---------------------------------------------------

describe("Activity Classification — Match-level, predeclared, locked", () => {
  it("an unclassified Match rejects a Prediction", async () => {
    const repo = new InMemoryPredictionsRepository();
    const home = await createTeam(repo, { name: "Home FC" });
    const away = await createTeam(repo, { name: "Away FC" });
    const match = await createMatch(repo, { homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Test Cup", kickoffAt: futureIso() });
    const venue = await createVenue(repo, { name: "Test Venue", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
    const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });

    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 0, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
      })
    ).rejects.toBeInstanceOf(MatchNotClassifiedError);
  });

  it("a RANKED Match accepts a Prediction", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupRankedMatch(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    expect(prediction.matchId).toBe(match.matchId);
  });

  it("classification is freely changeable before any Prediction or Result evidence exists", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match } = await setupRankedMatch(repo);
    const changed = await setMatchActivityClassification(repo, match.matchId, "CASUAL");
    expect(changed.activityClassification).toBe("CASUAL");
    expect(changed.locked).toBe(false);
  });

  it("classification becomes immutable once a Prediction exists", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupRankedMatch(repo);
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    await expect(setMatchActivityClassification(repo, match.matchId, "CASUAL")).rejects.toBeInstanceOf(
      ActivityClassificationLockedError
    );
    // Re-declaring the SAME value is idempotent, not an error.
    const same = await setMatchActivityClassification(repo, match.matchId, "RANKED");
    expect(same.locked).toBe(true);
  });

  it("classification becomes immutable once Result evidence exists, even with zero Predictions", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match } = await setupRankedMatch(repo);
    await saveDraftResult(repo, { matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: "gm-admin" });
    await expect(setMatchActivityClassification(repo, match.matchId, "CASUAL")).rejects.toBeInstanceOf(
      ActivityClassificationLockedError
    );
  });

  it("no Experience may be upgraded from Casual to Ranked (or any other classification) after evidence exists — the mechanism is symmetric for every pair", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation } = await setupRankedMatch(repo);
    await setMatchActivityClassification(repo, match.matchId, "CASUAL");
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinute: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    await expect(setMatchActivityClassification(repo, match.matchId, "RANKED")).rejects.toBeInstanceOf(
      ActivityClassificationLockedError
    );
  });
});

// --- TRAINING ---------------------------------------------------------

describe("TRAINING — zero XP, unconditionally", () => {
  it("a TRAINING classification produces zero XP events even for meaningful participation and a strong performance band", async () => {
    const repo = new InMemoryMetagameRepository();
    const gamingMemberId = randomUUID();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 5 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100 });

    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "TRAINING", authorityTier: "ADMIN_FINALIZED",
      occurredAt: new Date().toISOString(), finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "eval-training", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "eval-training", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(0);
  });

  it("TRAINING activity does not consume the daily participation allowance for other classifications", async () => {
    const repo = new InMemoryMetagameRepository();
    const gamingMemberId = randomUUID();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 1 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
    // Captured after the fixtures above so their effectiveAt ("now" at
    // creation) is never later than this occurredAt.
    const occurredAt = new Date().toISOString();

    const training = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "TRAINING", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: "eval-t1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "eval-t1", evidence: {},
    });
    await processExperienceSummaryConsequences(repo, training.experienceSummaryId);

    const ranked = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: "eval-r1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "eval-r1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, ranked.experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PARTICIPATION");
  });
});

// --- GAMING DAY --------------------------------------------------------

describe("Gaming Day — America/Tegucigalpa is authoritative, never device/client timezone", () => {
  async function seedPolicyAndRule(repo: InMemoryMetagameRepository, allowance: number) {
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: allowance });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
  }

  async function award(repo: InMemoryMetagameRepository, gamingMemberId: string, occurredAt: string, idempotencyKey: string) {
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: idempotencyKey, rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey, evidence: {},
    });
    return processExperienceSummaryConsequences(repo, experienceSummaryId);
  }

  it("two instants either side of Tegucigalpa midnight (06:00 UTC) land on different Gaming Days and each gets its own allowance slot", async () => {
    const repo = new InMemoryMetagameRepository();
    await seedPolicyAndRule(repo, 1);
    const gamingMemberId = randomUUID();

    // 05:59 UTC on 2027-01-15 = 2026-01-14 23:59 America/Tegucigalpa (UTC-6)
    const beforeMidnight = await award(repo, gamingMemberId, "2027-01-15T05:59:00.000Z", "before");
    // 06:01 UTC on 2027-01-15 = 2027-01-15 00:01 America/Tegucigalpa
    const afterMidnight = await award(repo, gamingMemberId, "2027-01-15T06:01:00.000Z", "after");

    expect(beforeMidnight).toHaveLength(1);
    expect(afterMidnight).toHaveLength(1); // different Gaming Day, allowance N=1 not yet consumed
  });

  it("two instants far apart in UTC but on the same Tegucigalpa calendar day share one allowance", async () => {
    const repo = new InMemoryMetagameRepository();
    await seedPolicyAndRule(repo, 1);
    const gamingMemberId = randomUUID();

    // 06:01 UTC and 23:59 UTC on 2027-01-15 are both 2027-01-15 in America/Tegucigalpa
    const first = await award(repo, gamingMemberId, "2027-01-15T06:01:00.000Z", "am");
    const second = await award(repo, gamingMemberId, "2027-01-15T23:59:00.000Z", "pm");

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // allowance already exhausted for this Tegucigalpa day
  });
});

// --- ALLOWANCE (configurable N) ----------------------------------------

describe("Daily participation allowance — configurable N, never a Product-chosen default", () => {
  async function seed(repo: InMemoryMetagameRepository, allowance: number) {
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: allowance });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
  }
  async function award(repo: InMemoryMetagameRepository, gamingMemberId: string, activityClassification: "CASUAL" | "RANKED" | "OFFICIAL", key: string, occurredAt: string) {
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification, authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: key, rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: key, evidence: {},
    });
    return processExperienceSummaryConsequences(repo, experienceSummaryId);
  }

  it("N=1 fixture: a second same-day meaningful participation is not awarded, but the Summary is still valid and no error is thrown", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 1);
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    expect(await award(repo, gamingMemberId, "RANKED", "e1", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "RANKED", "e2", day)).toHaveLength(0);
  });

  it("N=2 fixture: the third same-day meaningful participation is withheld, not the second", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 2);
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    expect(await award(repo, gamingMemberId, "RANKED", "e1", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "RANKED", "e2", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "RANKED", "e3", day)).toHaveLength(0);
  });

  it("Casual, Ranked, and Official consume the SAME category allowance", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 2);
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    expect(await award(repo, gamingMemberId, "CASUAL", "e1", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "RANKED", "e2", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "OFFICIAL", "e3", day)).toHaveLength(0);
  });

  it("continued activity remains permitted after allowance exhaustion — the Experience Summary always records successfully", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 1);
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    await award(repo, gamingMemberId, "RANKED", "e1", day);
    const { alreadyRecorded } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt: day, finalizedAt: day, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: "e2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e2", evidence: {},
    });
    expect(alreadyRecorded).toBe(false); // recording itself is never blocked
  });

  it("performance XP remains independently eligible even when the participation allowance is exhausted", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 1);
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100 });
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    await award(repo, gamingMemberId, "RANKED", "e1", day);

    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt: day, finalizedAt: day, meaningfulParticipation: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e2", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PERFORMANCE");
    expect(events[0].points).toBe(100);
  });

});

// --- MISSING-POLICY BOUNDARY: absence of configuration is never an error ---
//
// A finalized Experience fact must not become invalid merely because
// no Gaming XP policy/rule is configured. Absence means "no applicable
// XP consequence," never "invalid Experience result." Deploying the XP
// infrastructure must never require Product XP numbers to exist.

describe("Missing-policy boundary — absence of configuration is never an error", () => {
  it("NO CONFIGURATION: a real Prediction finalize succeeds end-to-end with zero policy/rule rows — Evaluation, Summary, and Prize Qualification all behave normally, zero XP events", async () => {
    const repo = new InMemoryPredictionsRepository();
    const { match, activation, striker } = await setupRankedMatchNoXpConfig(repo);
    const gamingMemberId = "gm-no-config";

    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Grand Prize" });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: striker.playerId, predictedGoalMinute: 10, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });

    const draft = await saveDraftResult(repo, { matchId: match.matchId, homeScore: 2, awayScore: 1, officialGoalEvents: [{ scorerPlayerId: striker.playerId, minuteRegulation: 10 }], enteredByGamingMemberId: "gm-admin" });

    // Must not throw — this is the exact defect being corrected: a
    // missing policy/rule must never roll back Evaluation/Summary/
    // Prize Qualification.
    const finalized = await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    expect(finalized.alreadyFinalized).toBe(false);

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.correctDimensionCount).toBe(4);

    const events = await repo.metagameRepository.listXpEventsForMember(gamingMemberId);
    expect(events).toHaveLength(0); // zero XP rows — not merely zero-effective

    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(qualification).not.toBeNull(); // Prize Qualification is fully independent of XP configuration
  });

  it("PARTIAL CONFIGURATION: policy only, no PARTICIPATION rule — no PARTICIPATION event, no failure", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 10 });
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(0);
  });

  it("PARTIAL CONFIGURATION: policy + PARTICIPATION rule only, no PERFORMANCE rule — PARTICIPATION awarded, no PERFORMANCE event, no failure", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 10 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PARTICIPATION");
  });

  it("PARTIAL CONFIGURATION: PERFORMANCE rule only, no policy at all — no PARTICIPATION event, PERFORMANCE still applies, no failure", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100 });
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PERFORMANCE");
    expect(events[0].points).toBe(100);
  });

  it("PARTIAL CONFIGURATION: policy + rules exist, but no rule matches this specific performance_band_key — no PERFORMANCE event, PARTICIPATION still applies, no failure", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 10 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100 });
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      // CORRECT_1_OF_4 has no configured PERFORMANCE rule — only CORRECT_4_OF_4 does.
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: "CORRECT_1_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PARTICIPATION");
  });

  it("NO CONFIGURATION AT ALL: valid finalize with zero XP rows, then CORRECTION still succeeds with zero XP and no phantom reversal", async () => {
    const repo = new InMemoryMetagameRepository();
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";

    const original = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const originalEvents = await processExperienceSummaryConsequences(repo, original.experienceSummaryId);
    expect(originalEvents).toHaveLength(0); // no configuration at all — valid Summary, zero XP

    // A correction changes the finalized performance band (e.g. a
    // scorer dispute) — the superseding Summary must still succeed
    // with zero XP, and must not fabricate a reversal event for XP
    // that never existed.
    const correction = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: new Date().toISOString(), meaningfulParticipation: true, performanceBandKey: "CORRECT_3_OF_4",
      sourceReference: "e1-corrected", rulesetVersion: "v1", supersedesExperienceSummaryId: original.experienceSummaryId,
      idempotencyKey: "e1-corrected", evidence: {},
    });
    const correctionEvents = await processExperienceSummaryConsequences(repo, correction.experienceSummaryId);
    expect(correctionEvents).toHaveLength(0); // still zero XP — no phantom reversal, no fabricated award

    const allEvents = await repo.listXpEventsForMember(gamingMemberId);
    expect(allEvents).toHaveLength(0);
  });
});

// --- XP RULES: rule-version provenance / reversal restores allowance ---

describe("XP rule versioning and reversal", () => {
  it("a later rule-value change does not reinterpret an already-awarded event's historical points", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 10 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 50 });

    const gamingMemberId = randomUUID();
    const occurredAt = "2027-02-01T12:00:00.000Z";
    const first = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: false, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const firstEvents = await processExperienceSummaryConsequences(repo, first.experienceSummaryId);
    expect(firstEvents[0].points).toBe(50);

    // Rule value changes for future awards — must NOT rewrite the past.
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 999 });

    const stillFifty = await repo.listXpEventsForSummary(first.experienceSummaryId);
    expect(stillFifty[0].points).toBe(50);

    const second = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: false, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e2", evidence: {},
    });
    const secondEvents = await processExperienceSummaryConsequences(repo, second.experienceSummaryId);
    expect(secondEvents[0].points).toBe(999);
  });

  it("a reversed participation award restores the effective daily allowance without deleting either row", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 1 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });

    const gamingMemberId = randomUUID();
    const occurredAt = "2027-02-01T12:00:00.000Z";

    const original = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    await processExperienceSummaryConsequences(repo, original.experienceSummaryId);

    // Allowance now exhausted (N=1) — a fresh, unrelated participation attempt gets nothing.
    const blocked = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: "e2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e2", evidence: {},
    });
    expect(await processExperienceSummaryConsequences(repo, blocked.experienceSummaryId)).toHaveLength(0);

    // The ORIGINAL evidence turns out to have been invalid (disqualification-shaped correction) —
    // a superseding Summary with meaningfulParticipation: false reverses it.
    const correction = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: new Date().toISOString(), meaningfulParticipation: false, performanceBandKey: null,
      sourceReference: "e1-corrected", rulesetVersion: "v1", supersedesExperienceSummaryId: original.experienceSummaryId,
      idempotencyKey: "e1-corrected", evidence: {},
    });
    const correctionEvents = await processExperienceSummaryConsequences(repo, correction.experienceSummaryId);
    expect(correctionEvents).toHaveLength(1);
    expect(correctionEvents[0].points).toBe(-5);
    expect(correctionEvents[0].reversesGamingXpEventId).not.toBeNull();

    // Both the original award and its reversal still exist — nothing was deleted.
    const allEvents = await repo.listXpEventsForMember(gamingMemberId);
    expect(allEvents.filter((e) => e.experienceSummaryId === original.experienceSummaryId)).toHaveLength(1);
    expect(allEvents.filter((e) => e.experienceSummaryId === correction.experienceSummaryId)).toHaveLength(1);

    // The allowance slot is free again for a genuinely new participation the same Gaming Day.
    const retry = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, performanceBandKey: null,
      sourceReference: "e3", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e3", evidence: {},
    });
    expect(await processExperienceSummaryConsequences(repo, retry.experienceSummaryId)).toHaveLength(1);
  });
});

// --- ARCHITECTURAL BOUNDARY: Predictions reports facts, never selects consequences ---

describe("Boundary: Predictions reports facts, Metagame selects consequences (source-level)", () => {
  it("neither finalize_match_result_atomically nor correct_match_result_atomically references gaming_xp_rules or gaming_category_participation_policy", () => {
    const finalizeSql = readFileSync(
      "supabase/migrations/0091_finalize_match_result_atomically_uses_metagame.sql",
      "utf-8"
    );
    const correctSql = readFileSync(
      "supabase/migrations/0092_correct_match_result_atomically_uses_metagame.sql",
      "utf-8"
    );
    // Checks for actual SQL usage (a real FROM/INSERT/JOIN reference),
    // not any mention of the table name — these files' own boundary-
    // documenting comments legitimately name all three tables in prose.
    for (const sql of [finalizeSql, correctSql]) {
      expect(sql).not.toMatch(/\b(from|insert into|join)\s+gaming_xp_rules\b/i);
      expect(sql).not.toMatch(/\b(from|insert into|join)\s+gaming_category_participation_policy\b/i);
      expect(sql).not.toMatch(/\b(from|insert into|join)\s+gaming_xp_events\b/i);
    }
  });

  it("InMemoryPredictionsRepository's source never references gaming_xp_rules or the participation policy table directly", () => {
    const source = readFileSync("lib/gaming/predictions/db/inMemoryPredictionsRepository.ts", "utf-8");
    expect(source).not.toContain("xpRules");
    expect(source).not.toContain("participationPolic");
  });

  it("lib/gaming/metagame never imports from lib/gaming/predictions", () => {
    const files = [
      "lib/gaming/metagame/types.ts",
      "lib/gaming/metagame/recordExperienceSummary.ts",
      "lib/gaming/metagame/processExperienceSummaryConsequences.ts",
      "lib/gaming/metagame/db/metagameRepository.ts",
      "lib/gaming/metagame/db/inMemoryMetagameRepository.ts",
      "lib/gaming/metagame/db/supabaseMetagameRepository.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      // Checks for an actual import statement, not any mention of the
      // path — this file's own boundary-documenting comments legitimately
      // name "lib/gaming/predictions" in prose.
      expect(source).not.toMatch(/from\s+["'].*predictions/);
    }
  });
});
