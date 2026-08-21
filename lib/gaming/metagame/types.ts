/**
 * Persistent Metagame — Phase 1.
 *
 * Canonical types for the boundary between Experience runtime and
 * persistent Gaming identity: the Finalized Experience Summary and
 * the Gaming XP ledger it feeds. See
 * Product/Persistent_Metagame_Architecture.md and ADR-035 for the
 * governing Product/Architecture authority — this file only encodes
 * that authority in TypeScript, it does not extend it.
 *
 * This module must never import anything from lib/gaming/predictions
 * (or any other Experience domain). Ownership direction is strictly
 * Experience -> metagame contract, never the reverse.
 */

export type ActivityClassification = "TRAINING" | "CASUAL" | "RANKED" | "OFFICIAL";

export type AuthorityTier =
  | "SYSTEM_AUTHORITATIVE"
  | "ADMIN_FINALIZED"
  | "APPROVED_ORGANIZER"
  | "EXTERNAL_UNVERIFIED";

export type ConsequenceClass = "PARTICIPATION" | "PERFORMANCE";

/** The Finalized Experience Summary — the one object that crosses the Experience/Metagame boundary. */
export interface ExperienceSummaryRecord {
  experienceSummaryId: string;
  gamingMemberId: string;
  experienceKey: string;
  categoryKey: string;
  activityClassification: ActivityClassification;
  authorityTier: AuthorityTier;
  occurredAt: string;
  finalizedAt: string;
  meaningfulParticipation: boolean;
  performanceBandKey: string | null;
  sourceReference: string;
  rulesetVersion: string;
  supersedesExperienceSummaryId: string | null;
  idempotencyKey: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface RecordExperienceSummaryInput {
  gamingMemberId: string;
  experienceKey: string;
  categoryKey: string;
  activityClassification: ActivityClassification;
  authorityTier: AuthorityTier;
  occurredAt: string;
  finalizedAt: string;
  meaningfulParticipation: boolean;
  performanceBandKey: string | null;
  sourceReference: string;
  rulesetVersion: string;
  supersedesExperienceSummaryId: string | null;
  idempotencyKey: string;
  evidence: Record<string, unknown>;
}

export interface RecordExperienceSummaryResult {
  experienceSummaryId: string;
  alreadyRecorded: boolean;
}

export interface GamingXpEventRecord {
  gamingXpEventId: string;
  gamingMemberId: string;
  categoryKey: string;
  consequenceClass: ConsequenceClass;
  points: number;
  experienceSummaryId: string;
  gamingXpRuleId: string;
  gamingCategoryParticipationPolicyId: string | null;
  gamingDay: string;
  reversesGamingXpEventId: string | null;
  idempotencyKey: string;
  createdAt: string;
}

export interface ProcessedConsequence {
  gamingXpEventId: string;
  consequenceClass: ConsequenceClass;
  points: number;
  reversesGamingXpEventId: string | null;
  alreadyProcessed: boolean;
}

export interface GamingCategoryParticipationPolicyRecord {
  gamingCategoryParticipationPolicyId: string;
  categoryKey: string;
  dailyParticipationAllowance: number;
  gamingDayTimezone: string;
  effectiveAt: string;
  supersededAt: string | null;
}

export interface GamingXpRuleRecord {
  gamingXpRuleId: string;
  categoryKey: string;
  consequenceClass: ConsequenceClass;
  performanceBandKey: string | null;
  points: number;
  effectiveAt: string;
  supersededAt: string | null;
}

// --- Errors ---------------------------------------------------------

export class InvalidActivityClassificationError extends Error {
  constructor() {
    super("Activity classification must be one of TRAINING, CASUAL, RANKED, OFFICIAL.");
    this.name = "InvalidActivityClassificationError";
  }
}

export class InvalidAuthorityTierError extends Error {
  constructor() {
    super("Authority tier must be one of SYSTEM_AUTHORITATIVE, ADMIN_FINALIZED, APPROVED_ORGANIZER, EXTERNAL_UNVERIFIED.");
    this.name = "InvalidAuthorityTierError";
  }
}

export class ExperienceSummaryNotFoundError extends Error {
  constructor() {
    super("No Finalized Experience Summary exists for this id.");
    this.name = "ExperienceSummaryNotFoundError";
  }
}

export class NoParticipationPolicyConfiguredError extends Error {
  constructor(categoryKey: string) {
    super(`No category participation policy is effective for ${categoryKey} at the summary's occurred_at.`);
    this.name = "NoParticipationPolicyConfiguredError";
  }
}

export class NoXpRuleConfiguredError extends Error {
  constructor(categoryKey: string) {
    super(`No XP rule is effective for ${categoryKey} at the summary's occurred_at.`);
    this.name = "NoXpRuleConfiguredError";
  }
}
