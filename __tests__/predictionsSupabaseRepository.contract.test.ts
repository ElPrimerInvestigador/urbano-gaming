import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { finalizeMatchResult } from "../lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult } from "../lib/gaming/predictions/correctMatchResult";
import { redeemPrizeQualification } from "../lib/gaming/predictions/redeemPrizeQualification";
import { requireGamingAdmin } from "../lib/gaming/predictions/httpAuth";
import { InvalidGoalscorerSelectionError } from "../lib/gaming/predictions/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

const repo = new SupabasePredictionsRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdAuthUserIds: string[] = [];
const createdMatchIds: string[] = [];
const createdVenueIds: string[] = [];
const createdTeamIds: string[] = [];

async function createRealGamingMember(displayName: string): Promise<{ authUserId: string; gamingMemberId: string }> {
  const email = `predictions-contract-${randomUUID()}@example.com`;
  const { data, error } = await cleanupClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId };
}

/** Two Teams, two Players each — the same minimal proving case used throughout the behavioral suite. */
async function createTeamsAndRoster() {
  const home = await repo.createTeam({ name: `Real Madrid ${randomUUID().slice(0, 8)}` });
  const away = await repo.createTeam({ name: `Barcelona ${randomUUID().slice(0, 8)}` });
  createdTeamIds.push(home.teamId, away.teamId);
  const mbappe = await repo.createPlayer({ teamId: home.teamId, name: "Mbappe" });
  const vini = await repo.createPlayer({ teamId: home.teamId, name: "Vini" });
  const lewa = await repo.createPlayer({ teamId: away.teamId, name: "Lewandowski" });
  return { home, away, mbappe, vini, lewa };
}

function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

afterAll(async () => {
  await cleanupClient
    .from("progression_rule_points")
    .update({ points: 0 })
    .eq("rule_key", "PREDICTION_4_OF_4");
  await cleanupClient
    .from("progression_rule_points")
    .update({ points: 0 })
    .eq("rule_key", "PREDICTION_3_OF_4");

  // Deleted in dependency order (children first) — every FK here is a
  // deliberate plain reference (no ON DELETE CASCADE) for the real
  // schema's own correctness, so this test's own cleanup must respect
  // it explicitly rather than relying on a cascade that doesn't exist.
  for (const matchId of createdMatchIds) {
    const { data: results } = await cleanupClient
      .from("match_results")
      .select("match_result_id")
      .eq("match_id", matchId);
    const matchResultIds = (results ?? []).map((r) => r.match_result_id);

    const { data: predictions } = await cleanupClient
      .from("predictions")
      .select("prediction_id")
      .eq("match_id", matchId);
    const predictionIds = (predictions ?? []).map((p) => p.prediction_id);

    if (predictionIds.length > 0) {
      const { data: evaluations } = await cleanupClient
        .from("evaluations")
        .select("evaluation_id")
        .in("prediction_id", predictionIds);
      const evaluationIds = (evaluations ?? []).map((e) => e.evaluation_id);
      if (evaluationIds.length > 0) {
        await cleanupClient.from("prize_qualifications").delete().in("evaluation_id", evaluationIds);
        await cleanupClient.from("gaming_progression_events").delete().in("evaluation_id", evaluationIds);
      }
      await cleanupClient.from("evaluations").delete().in("prediction_id", predictionIds);
    }
    await cleanupClient.from("gaming_progression_events").delete().eq("match_id", matchId);
    await cleanupClient.from("predictions").delete().eq("match_id", matchId);

    if (matchResultIds.length > 0) {
      await cleanupClient.from("official_goal_events").delete().in("match_result_id", matchResultIds);
    }
    await cleanupClient.from("match_results").delete().eq("match_id", matchId);
    await cleanupClient.from("prize_tiers").delete().in(
      "venue_activation_id",
      (await cleanupClient.from("venue_activations").select("venue_activation_id").eq("match_id", matchId)).data?.map(
        (a) => a.venue_activation_id
      ) ?? []
    );
    await cleanupClient.from("venue_activations").delete().eq("match_id", matchId);
    await cleanupClient.from("matches").delete().eq("match_id", matchId);
  }
  for (const venueId of createdVenueIds) {
    await cleanupClient.from("venues").delete().eq("venue_id", venueId);
  }
  for (const teamId of createdTeamIds) {
    await cleanupClient.from("players").delete().eq("team_id", teamId);
    await cleanupClient.from("teams").delete().eq("team_id", teamId);
  }
  for (const authUserId of createdAuthUserIds) {
    await cleanupClient.auth.admin.deleteUser(authUserId);
  }
});

describe("SupabasePredictionsRepository contract", () => {
  it("full settlement pipeline against real local Postgres: four independent dimensions, own-goal credit, progression, prize qualification, correction", async () => {
    // progression_rule_points is seeded at 0 for every key by migration
    // 0060 (a genuine "not yet decided" placeholder) — set real,
    // non-zero values here so the compensating-reversal assertion below
    // is meaningful, without asserting anything about what value the
    // founder eventually configures.
    await cleanupClient
      .from("progression_rule_points")
      .update({ points: 100 })
      .eq("rule_key", "PREDICTION_4_OF_4");
    await cleanupClient
      .from("progression_rule_points")
      .update({ points: 10 })
      .eq("rule_key", "PREDICTION_3_OF_4");

    const admin = await createRealGamingMember("ContractAdmin");
    const alex = await createRealGamingMember("ContractAlex");
    const { home, away, mbappe, vini } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Contract Test",
      kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);

    const venue = await repo.createVenue({
      name: "Contract Venue",
      latitude: 10,
      longitude: 10,
      radiusMeters: 100,
    });
    createdVenueIds.push(venue.venueId);

    const activation = await repo.createVenueActivation({
      matchId: match.matchId,
      venueId: venue.venueId,
    });

    await repo.createPrizeTier({
      venueActivationId: activation.venueActivationId,
      correctDimensionCount: 4,
      prizeLabel: "Jersey",
    });
    await repo.createPrizeTier({
      venueActivationId: activation.venueActivationId,
      correctDimensionCount: 3,
      prizeLabel: "Sticker",
    });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId,
      gamingMemberId: alex.gamingMemberId,
      venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2,
      predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId,
      predictedGoalMinute: 20,
      predictedFirstTeamToScore: "HOME",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
    expect(prediction.geoEligible).toBe(true);

    const draft = await repo.saveDraftMatchResult({
      matchId: match.matchId,
      homeScore: 2,
      awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 20 },
        { scorerPlayerId: vini.playerId, minuteRegulation: 70 },
      ],
      enteredByGamingMemberId: admin.gamingMemberId,
    });

    const finalizeResult = await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);
    expect(finalizeResult.alreadyFinalized).toBe(false);

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation!.scorelineCorrect).toBe(true);
    expect(evaluation!.goalscorerCorrect).toBe(true);
    expect(evaluation!.goalMinuteCorrect).toBe(true);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
    expect(evaluation!.correctDimensionCount).toBe(4);

    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(qualification).not.toBeNull();

    const redeemResult = await redeemPrizeQualification(repo, qualification!.prizeQualificationId, admin.gamingMemberId);
    expect(redeemResult.alreadyRedeemed).toBe(false);

    // Correction: official result was actually 1-0 (Vini's goal disallowed).
    const correctionDraft = await repo.saveDraftMatchResult({
      matchId: match.matchId,
      homeScore: 1,
      awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 20 }],
      enteredByGamingMemberId: admin.gamingMemberId,
      supersedesMatchResultId: draft.matchResultId,
    });
    const correctionResult = await correctMatchResult(repo, correctionDraft.matchResultId, admin.gamingMemberId);
    expect(correctionResult.alreadyFinalized).toBe(false);

    const oldEvaluationStillIntact = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(oldEvaluationStillIntact!.correctDimensionCount).toBe(4);

    const newEvaluation = await repo.getEvaluation(prediction.predictionId, correctionDraft.matchResultId);
    // Scoreline now wrong (predicted 2-0, corrected 1-0); goalscorer,
    // goal minute, and first-team-to-score remain correct — 3/4.
    expect(newEvaluation!.correctDimensionCount).toBe(3);

    const oldQualificationAfterCorrection = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(oldQualificationAfterCorrection!.supersededAt).not.toBeNull();
    expect(oldQualificationAfterCorrection!.redeemedAt).not.toBeNull();

    const newQualification = await repo.getQualificationForEvaluation(newEvaluation!.evaluationId);
    expect(newQualification).not.toBeNull();

    const events = await repo.listProgressionEventsForMember(alex.gamingMemberId);
    const reversal = events.find((e) => e.reversesGamingProgressionEventId !== null);
    expect(reversal).toBeDefined();
    expect(reversal!.points).toBeLessThan(0);
  }, 30000);

  it("an own goal credits the opposing Team for First Team to Score, evaluated against the real database", async () => {
    const admin = await createRealGamingMember("ContractOwnGoalAdmin");
    const alex = await createRealGamingMember("ContractOwnGoalAlex");
    const { home, away, vini } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Contract Test",
      kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);

    const venue = await repo.createVenue({ name: "Own Goal Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    // Vini plays for Home; an own goal by Vini must credit AWAY.
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId,
      gamingMemberId: alex.gamingMemberId,
      venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0,
      predictedAwayScore: 1,
      predictedGoalscorerPlayerId: null,
      predictedGoalMinute: null,
      predictedFirstTeamToScore: "AWAY",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });

    const draft = await repo.saveDraftMatchResult({
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 1,
      officialGoalEvents: [{ scorerPlayerId: vini.playerId, minuteRegulation: 30, isOwnGoal: true }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  }, 30000);

  it("rejects a goalscorer who does not belong to either Match Team via the real database check", async () => {
    const alex = await createRealGamingMember("ContractRosterMismatch");
    const { home, away } = await createTeamsAndRoster();
    const outsiderTeam = await repo.createTeam({ name: `Outsiders ${randomUUID().slice(0, 8)}` });
    createdTeamIds.push(outsiderTeam.teamId);
    const outsider = await repo.createPlayer({ teamId: outsiderTeam.teamId, name: "Outsider" });

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    await expect(
      submitPrediction(repo, {
        matchId: match.matchId,
        gamingMemberId: alex.gamingMemberId,
        venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1,
        predictedAwayScore: 0,
        predictedGoalscorerPlayerId: outsider.playerId,
        predictedGoalMinute: 1,
        predictedFirstTeamToScore: "HOME",
        geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
      })
    ).rejects.toBeInstanceOf(InvalidGoalscorerSelectionError);
  });

  it("admin authority: non-admin rejected, admin accepted, revocation takes effect immediately", async () => {
    const nonAdmin = await createRealGamingMember("ContractNonAdmin");
    const soonAdmin = await createRealGamingMember("ContractSoonAdmin");

    const nonAdminLinkResponse = await cleanupClient.auth.admin.generateLink({
      type: "magiclink",
      email: (await cleanupClient.auth.admin.getUserById(nonAdmin.authUserId)).data.user!.email!,
    });
    if (!nonAdminLinkResponse.data.properties) {
      throw new Error("generateLink did not return properties.");
    }
    // generateLink does not return a usable access token directly in
    // this local stack; resolve a real session via verifyOtp against
    // the link's own token_hash instead, mirroring how the browser
    // adapter itself verifies a magic-link/OTP token.
    const verifyNonAdmin = await cleanupClient.auth.verifyOtp({
      token_hash: nonAdminLinkResponse.data.properties.hashed_token,
      type: "email",
    });
    const nonAdminToken = verifyNonAdmin.data.session!.access_token;

    const fakeRequestNonAdmin = new Request("http://localhost/test", {
      headers: { authorization: `Bearer ${nonAdminToken}` },
    });
    const nonAdminResult = await requireGamingAdmin(fakeRequestNonAdmin, {
      url: supabaseUrl!,
      serviceKey: supabaseServiceRoleKey!,
    });
    expect("errorResponse" in nonAdminResult).toBe(true);
    if ("errorResponse" in nonAdminResult) {
      expect(nonAdminResult.errorResponse.status).toBe(403);
    }

    await cleanupClient.from("gaming_admins").insert({ gaming_member_id: soonAdmin.gamingMemberId });

    const adminLinkResponse = await cleanupClient.auth.admin.generateLink({
      type: "magiclink",
      email: (await cleanupClient.auth.admin.getUserById(soonAdmin.authUserId)).data.user!.email!,
    });
    if (!adminLinkResponse.data.properties) {
      throw new Error("generateLink did not return properties.");
    }
    const verifyAdmin = await cleanupClient.auth.verifyOtp({
      token_hash: adminLinkResponse.data.properties.hashed_token,
      type: "email",
    });
    const adminToken = verifyAdmin.data.session!.access_token;

    const fakeRequestAdmin = new Request("http://localhost/test", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const adminResult = await requireGamingAdmin(fakeRequestAdmin, {
      url: supabaseUrl!,
      serviceKey: supabaseServiceRoleKey!,
    });
    expect("gamingMemberId" in adminResult).toBe(true);

    // Revocation takes effect on the very next check.
    await cleanupClient.from("gaming_admins").delete().eq("gaming_member_id", soonAdmin.gamingMemberId);
    const revokedResult = await requireGamingAdmin(fakeRequestAdmin, {
      url: supabaseUrl!,
      serviceKey: supabaseServiceRoleKey!,
    });
    expect("errorResponse" in revokedResult).toBe(true);
  }, 30000);
});
