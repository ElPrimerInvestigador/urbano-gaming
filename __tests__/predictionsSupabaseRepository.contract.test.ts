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
import { cancelMatch } from "../lib/gaming/predictions/adminCatalog";
import { InvalidGoalscorerSelectionError, InvalidGoalMinuteError, MatchCancelledError } from "../lib/gaming/predictions/types";

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
const createdGamingMemberIds: string[] = [];
const createdMatchIds: string[] = [];
const createdVenueIds: string[] = [];
const createdTeamIds: string[] = [];

async function createRealGamingMember(displayName: string): Promise<{ authUserId: string; gamingMemberId: string }> {
  const email = `predictions-contract-${randomUUID()}@example.com`;
  const { data, error } = await cleanupClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
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
  // Persistent Metagame Phase 1: gaming_xp_events/experience_summaries
  // reference gaming_members with no ON DELETE CASCADE (XP is
  // participation evidence, never silently cascade-deleted — see
  // 0088's own migration comment) — deleted explicitly here, in
  // dependency order, before the auth user delete that would otherwise
  // be blocked by that same deliberate FK restriction.
  if (createdGamingMemberIds.length > 0) {
    await cleanupClient.from("gaming_xp_events").delete().in("gaming_member_id", createdGamingMemberIds);
    await cleanupClient.from("experience_summaries").delete().in("gaming_member_id", createdGamingMemberIds);
  }
  await cleanupClient.from("gaming_xp_rules").delete().eq("category_key", "SOCCER_PREDICTIONS");
  await cleanupClient.from("gaming_category_participation_policy").delete().eq("category_key", "SOCCER_PREDICTIONS");

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
    // Persistent Metagame Phase 1: real fixture rows against the real
    // canonical XP ledger tables — never a Product-authorized value,
    // just enough to make the compensating-reversal assertion below
    // meaningful.
    await cleanupClient
      .from("gaming_category_participation_policy")
      .insert({ category_key: "SOCCER_PREDICTIONS", daily_participation_allowance: 1000 });
    await cleanupClient.from("gaming_xp_rules").insert([
      { category_key: "SOCCER_PREDICTIONS", consequence_class: "PARTICIPATION", performance_band_key: null, points: 5 },
      { category_key: "SOCCER_PREDICTIONS", consequence_class: "PERFORMANCE", performance_band_key: "CORRECT_4_OF_4", points: 100 },
      { category_key: "SOCCER_PREDICTIONS", consequence_class: "PERFORMANCE", performance_band_key: "CORRECT_3_OF_4", points: 10 },
    ]);

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
    await repo.setMatchActivityClassification(match.matchId, "RANKED");

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
      predictedGoalMinuteRegulation: 20, predictedGoalMinuteStoppage: null,
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

    // gaming_progression_events (0061) receives no new writes as of
    // this phase — the canonical Gaming XP ledger is gaming_xp_events,
    // consumed only through the Metagame's own record/process functions,
    // never queried by Predictions directly.
    expect(await repo.listProgressionEventsForMember(alex.gamingMemberId)).toHaveLength(0);

    const { data: xpEvents } = await cleanupClient
      .from("gaming_xp_events")
      .select("*")
      .eq("gaming_member_id", alex.gamingMemberId);
    const netTotal = (xpEvents ?? []).reduce((sum, e) => sum + e.points, 0);
    expect(netTotal).toBe(5 + 10); // participation (5) + corrected 3/4 performance (10)

    const xpReversal = (xpEvents ?? []).find((e) => e.reverses_gaming_xp_event_id !== null);
    expect(xpReversal).toBeDefined();
    expect(xpReversal!.points).toBe(-100);
    expect(xpReversal!.consequence_class).toBe("PERFORMANCE");

    const participationEvents = (xpEvents ?? []).filter((e) => e.consequence_class === "PARTICIPATION");
    expect(participationEvents).toHaveLength(1); // preserved, never reversed by an ordinary correctness correction
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
    await repo.setMatchActivityClassification(match.matchId, "RANKED");

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
      predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null,
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
    await repo.setMatchActivityClassification(match.matchId, "RANKED");
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
        predictedGoalMinuteRegulation: 1, predictedGoalMinuteStoppage: null,
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

  // --- PREDICTIONS-V2 -------------------------------------------------

  it("Predictions-v2: an invalid Goal-Time shape (stoppage without a 45/90 base) is rejected by the real database CHECK constraint", async () => {
    const alex = await createRealGamingMember("ContractGoalTimeInvalid");
    const { home, away } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED");
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
        predictedGoalscorerPlayerId: null,
        predictedGoalMinuteRegulation: 46, predictedGoalMinuteStoppage: 1,
        predictedFirstTeamToScore: null,
        geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
      })
    ).rejects.toBeInstanceOf(InvalidGoalMinuteError);
  }, 30000);

  it("Predictions-v2 acceptance gate (0100): a non-boundary official stoppage tuple (46, 1) is rejected by the real official_goal_events CHECK constraint", async () => {
    const admin = await createRealGamingMember("ContractOfficialBoundaryInvalid");
    const { home, away, mbappe } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED");

    // Calling repo.saveDraftMatchResult directly, bypassing
    // adminCatalog.ts's own TS-level guard entirely, so this proves
    // the real database constraint (0100) in isolation, not merely
    // the application-layer check that sits in front of it.
    await expect(
      repo.saveDraftMatchResult({
        matchId: match.matchId,
        homeScore: 1,
        awayScore: 0,
        officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 46, minuteStoppage: 1 }],
        enteredByGamingMemberId: admin.gamingMemberId,
      })
    ).rejects.toThrow(/official_goal_events_minute_stoppage_requires_boundary/);
  }, 30000);

  it("Predictions-v2 acceptance gate (0100): legal period-boundary stoppage tuples, including extra-time (105, 120), are accepted by the real database", async () => {
    const admin = await createRealGamingMember("ContractOfficialBoundaryValid");
    const { home, away, mbappe } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED");

    const draft = await repo.saveDraftMatchResult({
      matchId: match.matchId,
      homeScore: 4,
      awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 45, minuteStoppage: 2 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 90, minuteStoppage: 7 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 105, minuteStoppage: 1 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 120, minuteStoppage: 3 },
      ],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    const events = await repo.listGoalEventsForResult(draft.matchResultId);
    expect(events).toHaveLength(4);
  }, 30000);

  it("Predictions-v2: structural Goal Minute comparison distinguishes ordinary 46 from the true (45, stoppage 1) pair against real Postgres", async () => {
    const admin = await createRealGamingMember("ContractStoppageAdmin");
    const ordinaryGuesser = await createRealGamingMember("ContractStoppageOrdinary");
    const stoppageGuesser = await createRealGamingMember("ContractStoppageExact");
    const { home, away, mbappe } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED");
    const venue = await repo.createVenue({ name: "Stoppage Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
    const geo = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 };

    const ordinaryPrediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: ordinaryGuesser.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: 46, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: null, geo,
    });
    const stoppagePrediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: stoppageGuesser.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: 45, predictedGoalMinuteStoppage: 1,
      predictedFirstTeamToScore: null, geo,
    });

    // The one real official goal is genuinely first-half stoppage:
    // (45, stoppage 1) — summed elapsed minute 46, the exact collision
    // the old flattened `predicted_goal_minute` scheme could not see.
    const draft = await repo.saveDraftMatchResult({
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 45, minuteStoppage: 1 }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    const ordinaryEvaluation = await repo.getEvaluation(ordinaryPrediction.predictionId, draft.matchResultId);
    expect(ordinaryEvaluation!.goalMinuteCorrect).toBe(false);

    const stoppageEvaluation = await repo.getEvaluation(stoppagePrediction.predictionId, draft.matchResultId);
    expect(stoppageEvaluation!.goalMinuteCorrect).toBe(true);
  }, 30000);

  it("Predictions-v2: an own goal is excluded from Any Goalscorer but included for Any Goal Minute against real Postgres", async () => {
    const admin = await createRealGamingMember("ContractOwnGoalDimensionsAdmin");
    const alex = await createRealGamingMember("ContractOwnGoalDimensionsAlex");
    const { home, away, vini } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED");
    const venue = await repo.createVenue({ name: "Own Goal Dimensions Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: alex.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: vini.playerId, predictedGoalMinuteRegulation: 30, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });

    const draft = await repo.saveDraftMatchResult({
      matchId: match.matchId, homeScore: 0, awayScore: 1,
      officialGoalEvents: [{ scorerPlayerId: vini.playerId, minuteRegulation: 30, isOwnGoal: true }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation!.goalscorerCorrect).toBe(false); // Vini's own goal does not satisfy predicting Vini as scorer
    expect(evaluation!.goalMinuteCorrect).toBe(true); // the same own goal DOES satisfy the matching minute
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true); // credits AWAY, the receiving side
  }, 30000);

  it("Predictions-v2: a cancelled Match cannot be finalized against real Postgres, and produces zero Evaluation rows", async () => {
    const admin = await createRealGamingMember("ContractCancelledAdmin");
    const alex = await createRealGamingMember("ContractCancelledAlex");
    const { home, away, mbappe } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED");
    const venue = await repo.createVenue({ name: "Cancelled Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: alex.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });

    const draft = await repo.saveDraftMatchResult({
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });

    await cancelMatch(repo, match.matchId);

    await expect(finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId)).rejects.toBeInstanceOf(
      MatchCancelledError
    );

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation).toBeNull();
  }, 30000);
});
