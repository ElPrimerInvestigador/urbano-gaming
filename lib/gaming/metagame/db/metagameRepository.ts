import type {
  RecordExperienceSummaryInput,
  RecordExperienceSummaryResult,
  ProcessedConsequence,
  ExperienceSummaryRecord,
  GamingXpEventRecord,
  GamingCategoryParticipationPolicyRecord,
  GamingXpRuleRecord,
  ConsequenceClass,
} from "../types";

/**
 * Persistent Metagame persistence boundary — its own interface,
 * parallel to every other domain's db/*Repository.ts, never merged
 * with them. No method here ever takes an Experience's own record
 * (a Prediction, an Evaluation, a Poker Hand) as input — only
 * already-normalized Finalized Experience Summary fields and ids.
 */
export interface MetagameRepository {
  recordExperienceSummary(input: RecordExperienceSummaryInput): Promise<RecordExperienceSummaryResult>;
  processExperienceSummaryConsequences(experienceSummaryId: string): Promise<ProcessedConsequence[]>;

  getExperienceSummary(experienceSummaryId: string): Promise<ExperienceSummaryRecord | null>;
  getExperienceSummaryByIdempotencyKey(
    experienceKey: string,
    idempotencyKey: string
  ): Promise<ExperienceSummaryRecord | null>;

  listXpEventsForMember(gamingMemberId: string): Promise<GamingXpEventRecord[]>;
  listXpEventsForSummary(experienceSummaryId: string): Promise<GamingXpEventRecord[]>;

  /** Test/fixture seam — Phase 1 has no admin route for configuring these; local tests insert explicit values directly. */
  createCategoryParticipationPolicy(input: {
    categoryKey: string;
    dailyParticipationAllowance: number;
    gamingDayTimezone?: string;
  }): Promise<GamingCategoryParticipationPolicyRecord>;

  /** Test/fixture seam — same reasoning as above; no Product XP values are ever seeded by non-test code. */
  createGamingXpRule(input: {
    categoryKey: string;
    consequenceClass: ConsequenceClass;
    performanceBandKey: string | null;
    points: number;
  }): Promise<GamingXpRuleRecord>;
}
