import { randomUUID } from "crypto";
import type { PredictionsRepository } from "./predictionsRepository";
import type {
  TeamRecord,
  PlayerRecord,
  MatchRecord,
  VenueRecord,
  VenueActivationRecord,
  PrizeTierRecord,
  PredictionRecord,
  MatchResultRecord,
  OfficialGoalEventRecord,
  OfficialGoalEventInput,
  EvaluationRecord,
  GamingProgressionEventRecord,
  PrizeQualificationRecord,
  LeaderboardEntry,
} from "../types";
import {
  MatchNotFoundError,
  MatchCancelledError,
  KickoffPassedError,
  VenueActivationNotFoundError,
  VenueActivationMatchMismatchError,
  VenueActivationDisabledError,
  VenueActivationImmutableError,
  GeoNotEligibleError,
  InvalidPredictionScoreError,
  InvalidGoalMinuteError,
  InvalidFirstTeamError,
  InvalidGoalscorerSelectionError,
  MatchResultNotFoundError,
  NotACorrectionError,
  SupersededResultNotFinalizedError,
  PrizeQualificationNotFoundError,
  QualificationSupersededError,
  DraftResultAlreadyExistsError,
} from "../types";

const PROGRESSION_RULE_KEYS = [
  "PREDICTION_PARTICIPATED",
  "PREDICTION_1_OF_4",
  "PREDICTION_2_OF_4",
  "PREDICTION_3_OF_4",
  "PREDICTION_4_OF_4",
];

/**
 * In-memory PredictionsRepository for behavioral tests — mirrors
 * lib/session/db/inMemorySessionRepository.ts's role: independently
 * re-implements the same invariants the real Postgres functions
 * enforce (roster-membership validation, kickoff lock, venue-activation
 * immutability, four-independent-dimension settlement, own-goal credit
 * derivation, chronological-first-goal derivation, append-only
 * progression compensation), not a thin passthrough.
 */
export class InMemoryPredictionsRepository implements PredictionsRepository {
  private teams = new Map<string, TeamRecord>();
  private players = new Map<string, PlayerRecord>();
  private matches = new Map<string, MatchRecord>();
  private venues = new Map<string, VenueRecord>();
  private activations = new Map<string, VenueActivationRecord>();
  private prizeTiers = new Map<string, PrizeTierRecord>();
  private predictions = new Map<string, PredictionRecord>();
  private matchResults = new Map<string, MatchResultRecord>();
  private goalEvents = new Map<string, OfficialGoalEventRecord[]>();
  private evaluations = new Map<string, EvaluationRecord>();
  private progressionEvents = new Map<string, GamingProgressionEventRecord>();
  private qualifications = new Map<string, PrizeQualificationRecord>();
  private progressionRulePoints = new Map<string, number>(
    PROGRESSION_RULE_KEYS.map((k) => [k, 0])
  );

  /** Test-only seam: configure a progression rule's point value. */
  setRulePoints(ruleKey: string, points: number): void {
    this.progressionRulePoints.set(ruleKey, points);
  }

  async createTeam(input: { name: string }): Promise<TeamRecord> {
    const record: TeamRecord = {
      teamId: randomUUID(),
      name: input.name,
      createdAt: new Date().toISOString(),
    };
    this.teams.set(record.teamId, record);
    return record;
  }

  async getTeamById(teamId: string): Promise<TeamRecord | null> {
    return this.teams.get(teamId) ?? null;
  }

  async listTeams(): Promise<TeamRecord[]> {
    return [...this.teams.values()];
  }

  async createPlayer(input: { teamId: string; name: string }): Promise<PlayerRecord> {
    const record: PlayerRecord = {
      playerId: randomUUID(),
      teamId: input.teamId,
      name: input.name,
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.players.set(record.playerId, record);
    return record;
  }

  async editPlayer(playerId: string, input: { name: string }): Promise<PlayerRecord> {
    const existing = this.players.get(playerId);
    if (!existing) throw new Error("Player not found.");
    const updated = { ...existing, name: input.name };
    this.players.set(playerId, updated);
    return updated;
  }

  async setPlayerActive(playerId: string, active: boolean): Promise<PlayerRecord> {
    const existing = this.players.get(playerId);
    if (!existing) throw new Error("Player not found.");
    const updated = { ...existing, active };
    this.players.set(playerId, updated);
    return updated;
  }

  async getPlayerById(playerId: string): Promise<PlayerRecord | null> {
    return this.players.get(playerId) ?? null;
  }

  async listPlayersForTeam(teamId: string): Promise<PlayerRecord[]> {
    return [...this.players.values()].filter((p) => p.teamId === teamId);
  }

  async createMatch(input: {
    homeTeamId: string;
    awayTeamId: string;
    competition: string;
    kickoffAt: string;
  }): Promise<MatchRecord> {
    const record: MatchRecord = {
      matchId: randomUUID(),
      homeTeamId: input.homeTeamId,
      awayTeamId: input.awayTeamId,
      competition: input.competition,
      kickoffAt: input.kickoffAt,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
    };
    this.matches.set(record.matchId, record);
    return record;
  }

  async editMatch(
    matchId: string,
    input: { homeTeamId: string; awayTeamId: string; competition: string; kickoffAt: string }
  ): Promise<MatchRecord> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();
    const updated = { ...existing, ...input };
    this.matches.set(matchId, updated);
    return updated;
  }

  async cancelMatch(matchId: string): Promise<MatchRecord> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();
    const updated = { ...existing, cancelledAt: new Date().toISOString() };
    this.matches.set(matchId, updated);
    return updated;
  }

  async getMatchById(matchId: string): Promise<MatchRecord | null> {
    return this.matches.get(matchId) ?? null;
  }

  async listMatches(): Promise<MatchRecord[]> {
    return [...this.matches.values()];
  }

  async createVenue(input: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  }): Promise<VenueRecord> {
    const record: VenueRecord = {
      venueId: randomUUID(),
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMeters,
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.venues.set(record.venueId, record);
    return record;
  }

  async editVenue(
    venueId: string,
    input: {
      name: string;
      latitude: number;
      longitude: number;
      radiusMeters: number;
      active: boolean;
    }
  ): Promise<VenueRecord> {
    const existing = this.venues.get(venueId);
    if (!existing) throw new Error("Venue not found.");
    const updated = { ...existing, ...input };
    this.venues.set(venueId, updated);
    return updated;
  }

  async getVenueById(venueId: string): Promise<VenueRecord | null> {
    return this.venues.get(venueId) ?? null;
  }

  async listVenues(): Promise<VenueRecord[]> {
    return [...this.venues.values()];
  }

  async createVenueActivation(input: {
    matchId: string;
    venueId: string;
  }): Promise<VenueActivationRecord> {
    const record: VenueActivationRecord = {
      venueActivationId: randomUUID(),
      matchId: input.matchId,
      venueId: input.venueId,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.activations.set(record.venueActivationId, record);
    return record;
  }

  async setVenueActivationEnabled(
    venueActivationId: string,
    enabled: boolean
  ): Promise<VenueActivationRecord> {
    const existing = this.activations.get(venueActivationId);
    if (!existing) throw new VenueActivationNotFoundError();
    const updated = { ...existing, enabled };
    this.activations.set(venueActivationId, updated);
    return updated;
  }

  async getVenueActivationById(
    venueActivationId: string
  ): Promise<VenueActivationRecord | null> {
    return this.activations.get(venueActivationId) ?? null;
  }

  async listVenueActivationsForMatch(matchId: string): Promise<VenueActivationRecord[]> {
    return [...this.activations.values()].filter((a) => a.matchId === matchId);
  }

  async createPrizeTier(input: {
    venueActivationId: string;
    correctDimensionCount: number;
    prizeLabel: string;
  }): Promise<PrizeTierRecord> {
    const record: PrizeTierRecord = {
      prizeTierId: randomUUID(),
      venueActivationId: input.venueActivationId,
      correctDimensionCount: input.correctDimensionCount,
      prizeLabel: input.prizeLabel,
      createdAt: new Date().toISOString(),
    };
    this.prizeTiers.set(record.prizeTierId, record);
    return record;
  }

  async listPrizeTiersForActivation(venueActivationId: string): Promise<PrizeTierRecord[]> {
    return [...this.prizeTiers.values()].filter(
      (t) => t.venueActivationId === venueActivationId
    );
  }

  async upsertPrediction(input: {
    matchId: string;
    gamingMemberId: string;
    venueActivationId: string;
    predictedHomeScore: number;
    predictedAwayScore: number;
    predictedGoalscorerPlayerId: string | null;
    predictedGoalMinute: number | null;
    predictedFirstTeamToScore: "HOME" | "AWAY" | null;
    geoVerifiedAt: string;
    measuredDistanceMeters: number;
    reportedAccuracyMeters: number | null;
    geoEligible: boolean;
  }): Promise<PredictionRecord> {
    const match = this.matches.get(input.matchId);
    if (!match) throw new MatchNotFoundError();
    if (match.cancelledAt) throw new MatchCancelledError();
    if (new Date() >= new Date(match.kickoffAt)) throw new KickoffPassedError();

    const activation = this.activations.get(input.venueActivationId);
    if (!activation) throw new VenueActivationNotFoundError();
    if (activation.matchId !== input.matchId) throw new VenueActivationMatchMismatchError();
    if (!activation.enabled) throw new VenueActivationDisabledError();

    if (!input.geoEligible) throw new GeoNotEligibleError();

    if (input.predictedHomeScore < 0 || input.predictedAwayScore < 0) {
      throw new InvalidPredictionScoreError();
    }

    if (
      input.predictedGoalMinute !== null &&
      (input.predictedGoalMinute < 1 || input.predictedGoalMinute > 120)
    ) {
      throw new InvalidGoalMinuteError();
    }

    if (
      input.predictedFirstTeamToScore !== null &&
      input.predictedFirstTeamToScore !== "HOME" &&
      input.predictedFirstTeamToScore !== "AWAY"
    ) {
      throw new InvalidFirstTeamError();
    }

    if (input.predictedGoalscorerPlayerId !== null) {
      const player = this.players.get(input.predictedGoalscorerPlayerId);
      if (!player) throw new InvalidGoalscorerSelectionError();
      if (player.teamId !== match.homeTeamId && player.teamId !== match.awayTeamId) {
        throw new InvalidGoalscorerSelectionError();
      }
      if (!player.active) throw new InvalidGoalscorerSelectionError();
    }

    const existing = [...this.predictions.values()].find(
      (p) => p.matchId === input.matchId && p.gamingMemberId === input.gamingMemberId
    );

    if (existing && existing.venueActivationId !== input.venueActivationId) {
      throw new VenueActivationImmutableError();
    }

    const now = new Date().toISOString();
    const record: PredictionRecord = {
      predictionId: existing?.predictionId ?? randomUUID(),
      matchId: input.matchId,
      gamingMemberId: input.gamingMemberId,
      venueActivationId: input.venueActivationId,
      predictedHomeScore: input.predictedHomeScore,
      predictedAwayScore: input.predictedAwayScore,
      predictedGoalscorerPlayerId: input.predictedGoalscorerPlayerId,
      predictedGoalMinute: input.predictedGoalMinute,
      predictedFirstTeamToScore: input.predictedFirstTeamToScore,
      geoVerifiedAt: input.geoVerifiedAt,
      measuredDistanceMeters: input.measuredDistanceMeters,
      reportedAccuracyMeters: input.reportedAccuracyMeters,
      geoEligible: input.geoEligible,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.predictions.set(record.predictionId, record);
    return record;
  }

  async getPredictionForMember(
    matchId: string,
    gamingMemberId: string
  ): Promise<PredictionRecord | null> {
    return (
      [...this.predictions.values()].find(
        (p) => p.matchId === matchId && p.gamingMemberId === gamingMemberId
      ) ?? null
    );
  }

  async listPredictionsForMatch(matchId: string): Promise<PredictionRecord[]> {
    return [...this.predictions.values()].filter((p) => p.matchId === matchId);
  }

  async saveDraftMatchResult(input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
    supersedesMatchResultId?: string | null;
  }): Promise<MatchResultRecord> {
    const existingDraft = await this.getDraftMatchResult(input.matchId);

    let record: MatchResultRecord;
    if (existingDraft) {
      record = { ...existingDraft, homeScore: input.homeScore, awayScore: input.awayScore };
    } else {
      record = {
        matchResultId: randomUUID(),
        matchId: input.matchId,
        homeScore: input.homeScore,
        awayScore: input.awayScore,
        finalizedAt: null,
        supersedesMatchResultId: input.supersedesMatchResultId ?? null,
        enteredByGamingMemberId: input.enteredByGamingMemberId,
        createdAt: new Date().toISOString(),
      };
    }
    this.matchResults.set(record.matchResultId, record);

    this.goalEvents.set(
      record.matchResultId,
      input.officialGoalEvents.map((event, index) => ({
        officialGoalEventId: randomUUID(),
        matchResultId: record.matchResultId,
        scorerPlayerId: event.scorerPlayerId,
        minuteRegulation: event.minuteRegulation,
        minuteStoppage: event.minuteStoppage ?? null,
        isOwnGoal: event.isOwnGoal ?? false,
        ordinal: index + 1,
      }))
    );

    return record;
  }

  async getMatchResultById(matchResultId: string): Promise<MatchResultRecord | null> {
    return this.matchResults.get(matchResultId) ?? null;
  }

  async getDraftMatchResult(matchId: string): Promise<MatchResultRecord | null> {
    return (
      [...this.matchResults.values()].find(
        (r) => r.matchId === matchId && r.finalizedAt === null
      ) ?? null
    );
  }

  async getCurrentFinalizedMatchResult(matchId: string): Promise<MatchResultRecord | null> {
    const finalized = [...this.matchResults.values()]
      .filter((r) => r.matchId === matchId && r.finalizedAt !== null)
      .sort((a, b) => (a.finalizedAt! < b.finalizedAt! ? 1 : -1));
    return finalized[0] ?? null;
  }

  async listGoalEventsForResult(matchResultId: string): Promise<OfficialGoalEventRecord[]> {
    return this.goalEvents.get(matchResultId) ?? [];
  }

  /**
   * Mirrors finalize_match_result_atomically's own once-per-Result-
   * Version facts: the total official goal count, and the
   * chronologically first goal's credited Team (HOME/AWAY/NO_GOAL) —
   * ordered by effective elapsed minute, then ordinal as a tiebreaker,
   * exactly as the SQL function orders. An own goal credits the
   * *opposing* Team from the scorer's own Team.
   */
  private deriveOfficialFacts(
    matchId: string,
    matchResultId: string
  ): { goalCount: number; firstTeam: "HOME" | "AWAY" | "NO_GOAL" } {
    const match = this.matches.get(matchId)!;
    const events = [...(this.goalEvents.get(matchResultId) ?? [])].sort((a, b) => {
      const aMinute = a.minuteRegulation + (a.minuteStoppage ?? 0);
      const bMinute = b.minuteRegulation + (b.minuteStoppage ?? 0);
      if (aMinute !== bMinute) return aMinute - bMinute;
      return a.ordinal - b.ordinal;
    });

    if (events.length === 0) {
      return { goalCount: 0, firstTeam: "NO_GOAL" };
    }

    const first = events[0];
    const scorer = this.players.get(first.scorerPlayerId);
    const scorerTeamId = scorer?.teamId;
    let firstTeam: "HOME" | "AWAY";
    if (first.isOwnGoal) {
      firstTeam = scorerTeamId === match.homeTeamId ? "AWAY" : "HOME";
    } else {
      firstTeam = scorerTeamId === match.homeTeamId ? "HOME" : "AWAY";
    }

    return { goalCount: events.length, firstTeam };
  }

  private evaluatePrediction(
    prediction: PredictionRecord,
    result: MatchResultRecord,
    facts: { goalCount: number; firstTeam: "HOME" | "AWAY" | "NO_GOAL" },
    matchResultId: string
  ): {
    scorelineCorrect: boolean;
    goalscorerCorrect: boolean;
    goalMinuteCorrect: boolean;
    firstTeamToScoreCorrect: boolean;
    correctDimensionCount: number;
  } {
    const events = this.goalEvents.get(matchResultId) ?? [];

    const scorelineCorrect =
      prediction.predictedHomeScore === result.homeScore &&
      prediction.predictedAwayScore === result.awayScore;

    const goalscorerCorrect =
      prediction.predictedGoalscorerPlayerId === null
        ? facts.goalCount === 0
        : events.some((e) => e.scorerPlayerId === prediction.predictedGoalscorerPlayerId);

    const goalMinuteCorrect =
      prediction.predictedGoalMinute === null
        ? facts.goalCount === 0
        : events.some(
            (e) => e.minuteRegulation + (e.minuteStoppage ?? 0) === prediction.predictedGoalMinute
          );

    const firstTeamToScoreCorrect =
      prediction.predictedFirstTeamToScore === null
        ? facts.firstTeam === "NO_GOAL"
        : prediction.predictedFirstTeamToScore === facts.firstTeam;

    const correctDimensionCount =
      Number(scorelineCorrect) +
      Number(goalscorerCorrect) +
      Number(goalMinuteCorrect) +
      Number(firstTeamToScoreCorrect);

    return {
      scorelineCorrect,
      goalscorerCorrect,
      goalMinuteCorrect,
      firstTeamToScoreCorrect,
      correctDimensionCount,
    };
  }

  private awardProgressionEvent(
    gamingMemberId: string,
    ruleKey: string,
    matchId: string,
    evaluationId: string,
    idempotencyKey: string,
    reversesGamingProgressionEventId: string | null = null,
    explicitPoints: number | null = null
  ): void {
    const alreadyExists = [...this.progressionEvents.values()].some(
      (e) => e.gamingMemberId === gamingMemberId && e.idempotencyKey === idempotencyKey
    );
    if (alreadyExists) {
      return;
    }
    const points = explicitPoints ?? this.progressionRulePoints.get(ruleKey) ?? 0;
    const record: GamingProgressionEventRecord = {
      gamingProgressionEventId: randomUUID(),
      gamingMemberId,
      ruleKey,
      points,
      matchId,
      evaluationId,
      reversesGamingProgressionEventId,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    this.progressionEvents.set(record.gamingProgressionEventId, record);
  }

  async finalizeMatchResult(
    matchResultId: string,
    _finalizedByGamingMemberId: string
  ): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }> {
    const result = this.matchResults.get(matchResultId);
    if (!result) throw new MatchResultNotFoundError();
    if (result.finalizedAt) {
      return { matchResultId, finalizedAt: result.finalizedAt, alreadyFinalized: true };
    }

    const finalizedAt = new Date().toISOString();
    this.matchResults.set(matchResultId, { ...result, finalizedAt });

    const facts = this.deriveOfficialFacts(result.matchId, matchResultId);

    for (const prediction of [...this.predictions.values()].filter(
      (p) => p.matchId === result.matchId
    )) {
      const evaluated = this.evaluatePrediction(prediction, result, facts, matchResultId);

      const evaluation: EvaluationRecord = {
        evaluationId: randomUUID(),
        predictionId: prediction.predictionId,
        matchResultId,
        ...evaluated,
        evaluatedAt: new Date().toISOString(),
      };
      this.evaluations.set(evaluation.evaluationId, evaluation);

      this.awardProgressionEvent(
        prediction.gamingMemberId,
        "PREDICTION_PARTICIPATED",
        result.matchId,
        evaluation.evaluationId,
        `${evaluation.evaluationId}:PREDICTION_PARTICIPATED`
      );

      if (evaluated.correctDimensionCount > 0) {
        const ruleKey = `PREDICTION_${evaluated.correctDimensionCount}_OF_4`;
        this.awardProgressionEvent(
          prediction.gamingMemberId,
          ruleKey,
          result.matchId,
          evaluation.evaluationId,
          `${evaluation.evaluationId}:${ruleKey}`
        );
      }

      const tier = [...this.prizeTiers.values()].find(
        (t) =>
          t.venueActivationId === prediction.venueActivationId &&
          t.correctDimensionCount === evaluated.correctDimensionCount
      );
      if (tier) {
        const qualification: PrizeQualificationRecord = {
          prizeQualificationId: randomUUID(),
          evaluationId: evaluation.evaluationId,
          gamingMemberId: prediction.gamingMemberId,
          venueActivationId: prediction.venueActivationId,
          prizeTierId: tier.prizeTierId,
          redeemedAt: null,
          redeemedByGamingMemberId: null,
          supersededAt: null,
          createdAt: new Date().toISOString(),
        };
        this.qualifications.set(qualification.prizeQualificationId, qualification);
      }
    }

    return { matchResultId, finalizedAt, alreadyFinalized: false };
  }

  async correctMatchResult(
    matchResultId: string,
    _finalizedByGamingMemberId: string
  ): Promise<{
    matchResultId: string;
    finalizedAt: string;
    supersedesMatchResultId: string;
    alreadyFinalized: boolean;
  }> {
    const result = this.matchResults.get(matchResultId);
    if (!result) throw new MatchResultNotFoundError();
    if (!result.supersedesMatchResultId) throw new NotACorrectionError();
    if (result.finalizedAt) {
      return {
        matchResultId,
        finalizedAt: result.finalizedAt,
        supersedesMatchResultId: result.supersedesMatchResultId,
        alreadyFinalized: true,
      };
    }

    const supersedes = this.matchResults.get(result.supersedesMatchResultId);
    if (!supersedes || !supersedes.finalizedAt) {
      throw new SupersededResultNotFinalizedError();
    }

    const finalizedAt = new Date().toISOString();
    this.matchResults.set(matchResultId, { ...result, finalizedAt });

    const facts = this.deriveOfficialFacts(result.matchId, matchResultId);

    for (const prediction of [...this.predictions.values()].filter(
      (p) => p.matchId === result.matchId
    )) {
      const oldEvaluation = [...this.evaluations.values()].find(
        (e) =>
          e.predictionId === prediction.predictionId &&
          e.matchResultId === result.supersedesMatchResultId
      );

      const evaluated = this.evaluatePrediction(prediction, result, facts, matchResultId);

      const newEvaluation: EvaluationRecord = {
        evaluationId: randomUUID(),
        predictionId: prediction.predictionId,
        matchResultId,
        ...evaluated,
        evaluatedAt: new Date().toISOString(),
      };
      this.evaluations.set(newEvaluation.evaluationId, newEvaluation);

      if (oldEvaluation && oldEvaluation.correctDimensionCount > 0) {
        const oldRuleKey = `PREDICTION_${oldEvaluation.correctDimensionCount}_OF_4`;
        const oldTierEvent = [...this.progressionEvents.values()].find(
          (e) => e.evaluationId === oldEvaluation.evaluationId && e.ruleKey === oldRuleKey
        );
        if (oldTierEvent) {
          this.awardProgressionEvent(
            prediction.gamingMemberId,
            oldRuleKey,
            result.matchId,
            oldEvaluation.evaluationId,
            `reverse:${oldTierEvent.gamingProgressionEventId}`,
            oldTierEvent.gamingProgressionEventId,
            -oldTierEvent.points
          );
        }
      }

      if (evaluated.correctDimensionCount > 0) {
        const ruleKey = `PREDICTION_${evaluated.correctDimensionCount}_OF_4`;
        this.awardProgressionEvent(
          prediction.gamingMemberId,
          ruleKey,
          result.matchId,
          newEvaluation.evaluationId,
          `${newEvaluation.evaluationId}:${ruleKey}`
        );
      }

      if (oldEvaluation) {
        const oldQualification = [...this.qualifications.values()].find(
          (q) => q.evaluationId === oldEvaluation.evaluationId && !q.supersededAt
        );
        if (oldQualification) {
          this.qualifications.set(oldQualification.prizeQualificationId, {
            ...oldQualification,
            supersededAt: new Date().toISOString(),
          });
        }
      }

      const newTier = [...this.prizeTiers.values()].find(
        (t) =>
          t.venueActivationId === prediction.venueActivationId &&
          t.correctDimensionCount === evaluated.correctDimensionCount
      );
      if (newTier) {
        const qualification: PrizeQualificationRecord = {
          prizeQualificationId: randomUUID(),
          evaluationId: newEvaluation.evaluationId,
          gamingMemberId: prediction.gamingMemberId,
          venueActivationId: prediction.venueActivationId,
          prizeTierId: newTier.prizeTierId,
          redeemedAt: null,
          redeemedByGamingMemberId: null,
          supersededAt: null,
          createdAt: new Date().toISOString(),
        };
        this.qualifications.set(qualification.prizeQualificationId, qualification);
      }
    }

    return {
      matchResultId,
      finalizedAt,
      supersedesMatchResultId: result.supersedesMatchResultId,
      alreadyFinalized: false,
    };
  }

  async getEvaluation(
    predictionId: string,
    matchResultId: string
  ): Promise<EvaluationRecord | null> {
    return (
      [...this.evaluations.values()].find(
        (e) => e.predictionId === predictionId && e.matchResultId === matchResultId
      ) ?? null
    );
  }

  async getCurrentEvaluationForPrediction(
    predictionId: string
  ): Promise<EvaluationRecord | null> {
    const matches = [...this.evaluations.values()]
      .filter((e) => e.predictionId === predictionId)
      .sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? 1 : -1));
    return matches[0] ?? null;
  }

  async listProgressionEventsForMember(
    gamingMemberId: string
  ): Promise<GamingProgressionEventRecord[]> {
    return [...this.progressionEvents.values()].filter(
      (e) => e.gamingMemberId === gamingMemberId
    );
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const totals = new Map<string, number>();
    for (const event of this.progressionEvents.values()) {
      totals.set(event.gamingMemberId, (totals.get(event.gamingMemberId) ?? 0) + event.points);
    }
    return [...totals.entries()]
      .map(([gamingMemberId, totalPoints]) => ({
        gamingMemberId,
        displayName: "Unknown",
        totalPoints,
      }))
      .sort((a, b) => b.totalPoints - a.totalPoints);
  }

  async getQualificationForEvaluation(
    evaluationId: string
  ): Promise<PrizeQualificationRecord | null> {
    return (
      [...this.qualifications.values()].find((q) => q.evaluationId === evaluationId) ?? null
    );
  }

  async listQualificationsForMember(
    gamingMemberId: string
  ): Promise<PrizeQualificationRecord[]> {
    return [...this.qualifications.values()].filter((q) => q.gamingMemberId === gamingMemberId);
  }

  async listQualificationsForActivation(
    venueActivationId: string
  ): Promise<PrizeQualificationRecord[]> {
    return [...this.qualifications.values()].filter(
      (q) => q.venueActivationId === venueActivationId
    );
  }

  async redeemPrizeQualification(
    prizeQualificationId: string,
    redeemedByGamingMemberId: string
  ): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }> {
    const existing = this.qualifications.get(prizeQualificationId);
    if (!existing) throw new PrizeQualificationNotFoundError();
    if (existing.redeemedAt) {
      return { prizeQualificationId, redeemedAt: existing.redeemedAt, alreadyRedeemed: true };
    }
    if (existing.supersededAt) throw new QualificationSupersededError();

    const redeemedAt = new Date().toISOString();
    this.qualifications.set(prizeQualificationId, {
      ...existing,
      redeemedAt,
      redeemedByGamingMemberId,
    });
    return { prizeQualificationId, redeemedAt, alreadyRedeemed: false };
  }
}
