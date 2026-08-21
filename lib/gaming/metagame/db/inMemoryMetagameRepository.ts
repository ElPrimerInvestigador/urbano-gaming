import { randomUUID } from "crypto";
import type { MetagameRepository } from "./metagameRepository";
import type {
  RecordExperienceSummaryInput,
  RecordExperienceSummaryResult,
  ProcessedConsequence,
  ExperienceSummaryRecord,
  GamingXpEventRecord,
  GamingCategoryParticipationPolicyRecord,
  GamingXpRuleRecord,
  GlobalLeaderboardEntry,
  ConsequenceClass,
} from "../types";
import {
  InvalidActivityClassificationError,
  InvalidAuthorityTierError,
  ExperienceSummaryNotFoundError,
} from "../types";

const ACTIVITY_CLASSIFICATIONS = ["TRAINING", "CASUAL", "RANKED", "OFFICIAL"];
const AUTHORITY_TIERS = ["SYSTEM_AUTHORITATIVE", "ADMIN_FINALIZED", "APPROVED_ORGANIZER", "EXTERNAL_UNVERIFIED"];

/** Derives the America/Tegucigalpa calendar date for a UTC instant — never client/device-supplied. */
function gamingDayFor(occurredAtIso: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(occurredAtIso));
}

/**
 * In-memory MetagameRepository for behavioral tests — independently
 * re-implements the same allowance-locking, correction-aware reversal,
 * and rule/policy resolution the real Postgres functions
 * (record_experience_summary_atomically,
 * process_experience_summary_consequences_atomically) enforce, not a
 * thin passthrough. Mirrors every other in-memory repository's role in
 * this codebase.
 */
export class InMemoryMetagameRepository implements MetagameRepository {
  private summaries = new Map<string, ExperienceSummaryRecord>();
  private summaryByNaturalKey = new Map<string, string>(); // `${experienceKey}:${idempotencyKey}` -> experienceSummaryId
  private xpEvents = new Map<string, GamingXpEventRecord>();
  private xpEventByIdempotency = new Map<string, string>(); // `${gamingMemberId}:${idempotencyKey}` -> gamingXpEventId
  private participationPolicies: GamingCategoryParticipationPolicyRecord[] = [];
  private xpRules: GamingXpRuleRecord[] = [];
  // Test/fixture seam — Metagame does not own Gaming Member identity
  // (gaming_members belongs to lib/gaming/db), so the in-memory ledger
  // has no independent way to learn a display name for an id it only
  // ever sees as an opaque gamingMemberId. Tests register the name a
  // fixture Gaming Member should display as; the real Postgres
  // implementation instead JOINs gaming_members directly inside
  // get_global_gaming_xp_leaderboard() (0093), which needs no such seam.
  private displayNames = new Map<string, string>();

  async recordExperienceSummary(input: RecordExperienceSummaryInput): Promise<RecordExperienceSummaryResult> {
    if (!ACTIVITY_CLASSIFICATIONS.includes(input.activityClassification)) {
      throw new InvalidActivityClassificationError();
    }
    if (!AUTHORITY_TIERS.includes(input.authorityTier)) {
      throw new InvalidAuthorityTierError();
    }

    const naturalKey = `${input.experienceKey}:${input.idempotencyKey}`;
    const existingId = this.summaryByNaturalKey.get(naturalKey);
    if (existingId) {
      return { experienceSummaryId: existingId, alreadyRecorded: true };
    }

    // Mirrors 0095's own table-level CHECK constraint exactly: both
    // dimension-fact fields present and consistent, or both absent
    // together. This function stays Experience-agnostic — it enforces
    // only the universal shape, never Predictions' own vocabulary.
    const correctDimensionCount = input.correctDimensionCount ?? null;
    const correctDimensionKeys = input.correctDimensionKeys ?? null;
    const bothPresent = correctDimensionCount !== null && correctDimensionKeys !== null;
    const bothAbsent = correctDimensionCount === null && correctDimensionKeys === null;
    if (!bothPresent && !bothAbsent) {
      throw new Error("correctDimensionCount and correctDimensionKeys must both be present or both be null.");
    }
    if (bothPresent && correctDimensionCount !== correctDimensionKeys!.length) {
      throw new Error("correctDimensionCount must equal correctDimensionKeys.length.");
    }

    const experienceSummaryId = randomUUID();
    const record: ExperienceSummaryRecord = {
      experienceSummaryId,
      gamingMemberId: input.gamingMemberId,
      experienceKey: input.experienceKey,
      categoryKey: input.categoryKey,
      activityClassification: input.activityClassification,
      authorityTier: input.authorityTier,
      occurredAt: input.occurredAt,
      finalizedAt: input.finalizedAt,
      meaningfulParticipation: input.meaningfulParticipation,
      performanceBandKey: input.performanceBandKey,
      sourceReference: input.sourceReference,
      rulesetVersion: input.rulesetVersion,
      supersedesExperienceSummaryId: input.supersedesExperienceSummaryId,
      idempotencyKey: input.idempotencyKey,
      evidence: input.evidence,
      correctDimensionCount,
      correctDimensionKeys,
      createdAt: new Date().toISOString(),
    };
    this.summaries.set(experienceSummaryId, record);
    this.summaryByNaturalKey.set(naturalKey, experienceSummaryId);
    return { experienceSummaryId, alreadyRecorded: false };
  }

  private insertXpEvent(input: {
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
  }): GamingXpEventRecord | null {
    const key = `${input.gamingMemberId}:${input.idempotencyKey}`;
    if (this.xpEventByIdempotency.has(key)) return null;

    const gamingXpEventId = randomUUID();
    const record: GamingXpEventRecord = {
      gamingXpEventId,
      gamingMemberId: input.gamingMemberId,
      categoryKey: input.categoryKey,
      consequenceClass: input.consequenceClass,
      points: input.points,
      experienceSummaryId: input.experienceSummaryId,
      gamingXpRuleId: input.gamingXpRuleId,
      gamingCategoryParticipationPolicyId: input.gamingCategoryParticipationPolicyId,
      gamingDay: input.gamingDay,
      reversesGamingXpEventId: input.reversesGamingXpEventId,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    this.xpEvents.set(gamingXpEventId, record);
    this.xpEventByIdempotency.set(key, gamingXpEventId);
    return record;
  }

  // Recency ties (equal effectiveAt millisecond) are broken by array
  // insertion order, not re-sorted by timestamp — a fixture created
  // later in a test always wins over one created earlier, exactly
  // matching intent even when both happen within the same millisecond.
  private resolvePolicy(categoryKey: string, occurredAt: string): GamingCategoryParticipationPolicyRecord | null {
    const occurredMs = new Date(occurredAt).getTime();
    for (let i = this.participationPolicies.length - 1; i >= 0; i--) {
      const p = this.participationPolicies[i];
      if (
        p.categoryKey === categoryKey &&
        new Date(p.effectiveAt).getTime() <= occurredMs &&
        (p.supersededAt === null || new Date(p.supersededAt).getTime() > occurredMs)
      ) {
        return p;
      }
    }
    return null;
  }

  private resolveRule(
    categoryKey: string,
    consequenceClass: ConsequenceClass,
    performanceBandKey: string | null,
    occurredAt: string
  ): GamingXpRuleRecord | null {
    const occurredMs = new Date(occurredAt).getTime();
    for (let i = this.xpRules.length - 1; i >= 0; i--) {
      const r = this.xpRules[i];
      if (
        r.categoryKey === categoryKey &&
        r.consequenceClass === consequenceClass &&
        r.performanceBandKey === performanceBandKey &&
        new Date(r.effectiveAt).getTime() <= occurredMs &&
        (r.supersededAt === null || new Date(r.supersededAt).getTime() > occurredMs)
      ) {
        return r;
      }
    }
    return null;
  }

  private effectiveEventsForSummary(experienceSummaryId: string): GamingXpEventRecord[] {
    const all = [...this.xpEvents.values()];
    const reversed = new Set(
      all.filter((e) => e.reversesGamingXpEventId).map((e) => e.reversesGamingXpEventId as string)
    );
    return all.filter(
      (e) => e.experienceSummaryId === experienceSummaryId && e.points > 0 && !reversed.has(e.gamingXpEventId)
    );
  }

  async processExperienceSummaryConsequences(experienceSummaryId: string): Promise<ProcessedConsequence[]> {
    const summary = this.summaries.get(experienceSummaryId);
    if (!summary) throw new ExperienceSummaryNotFoundError();

    const alreadyProcessed = [...this.xpEvents.values()].some(
      (e) => e.experienceSummaryId === experienceSummaryId
    );
    if (alreadyProcessed) {
      return [...this.xpEvents.values()]
        .filter((e) => e.experienceSummaryId === experienceSummaryId)
        .map((e) => ({
          gamingXpEventId: e.gamingXpEventId,
          consequenceClass: e.consequenceClass,
          points: e.points,
          reversesGamingXpEventId: e.reversesGamingXpEventId,
          alreadyProcessed: true,
        }));
    }

    // TRAINING carries zero XP consequence by Product definition,
    // regardless of what facts the Experience reports — mirrors
    // process_experience_summary_consequences_atomically's own guard.
    if (summary.activityClassification === "TRAINING") {
      return [];
    }

    const oldSummary = summary.supersedesExperienceSummaryId
      ? this.summaries.get(summary.supersedesExperienceSummaryId) ?? null
      : null;

    if (summary.supersedesExperienceSummaryId) {
      const oldEffective = this.effectiveEventsForSummary(summary.supersedesExperienceSummaryId);
      for (const old of oldEffective) {
        const shouldReverse =
          old.consequenceClass === "PERFORMANCE" ||
          (old.consequenceClass === "PARTICIPATION" &&
            Boolean(oldSummary?.meaningfulParticipation) &&
            !summary.meaningfulParticipation);
        if (shouldReverse) {
          this.insertXpEvent({
            gamingMemberId: summary.gamingMemberId,
            categoryKey: old.categoryKey,
            consequenceClass: old.consequenceClass,
            points: -old.points,
            experienceSummaryId,
            gamingXpRuleId: old.gamingXpRuleId,
            gamingCategoryParticipationPolicyId: old.gamingCategoryParticipationPolicyId,
            gamingDay: old.gamingDay,
            reversesGamingXpEventId: old.gamingXpEventId,
            idempotencyKey: `reverse:${old.gamingXpEventId}`,
          });
        }
      }
    }

    const oldStandingParticipation =
      summary.supersedesExperienceSummaryId !== null &&
      Boolean(oldSummary?.meaningfulParticipation) &&
      this.effectiveEventsForSummary(summary.supersedesExperienceSummaryId).some(
        (e) => e.consequenceClass === "PARTICIPATION"
      );

    // Missing-policy boundary correction: the absence of a configured
    // category participation policy, or of a PARTICIPATION rule, is a
    // valid Product state — "no applicable XP consequence" — never an
    // invalid Experience result. Neither case may throw here, since
    // this method is called from within the Experience's own
    // finalize/correct flow and an exception here must never be able
    // to invalidate an otherwise-valid Result/Evaluation/Summary.
    if (summary.meaningfulParticipation && !oldStandingParticipation) {
      const policy = this.resolvePolicy(summary.categoryKey, summary.occurredAt);

      if (policy) {
        const gamingDay = gamingDayFor(summary.occurredAt, policy.gamingDayTimezone);

        // Counts only currently-EFFECTIVE participation awards — a
        // reversed award frees its slot back up rather than remaining
        // permanently counted. Neither row is ever deleted.
        const reversedIds = new Set(
          [...this.xpEvents.values()]
            .filter((e) => e.reversesGamingXpEventId)
            .map((e) => e.reversesGamingXpEventId as string)
        );
        const existingCount = [...this.xpEvents.values()].filter(
          (e) =>
            e.gamingMemberId === summary.gamingMemberId &&
            e.categoryKey === summary.categoryKey &&
            e.gamingDay === gamingDay &&
            e.consequenceClass === "PARTICIPATION" &&
            e.points > 0 &&
            !reversedIds.has(e.gamingXpEventId)
        ).length;

        if (existingCount < policy.dailyParticipationAllowance) {
          const rule = this.resolveRule(summary.categoryKey, "PARTICIPATION", null, summary.occurredAt);

          if (rule) {
            this.insertXpEvent({
              gamingMemberId: summary.gamingMemberId,
              categoryKey: summary.categoryKey,
              consequenceClass: "PARTICIPATION",
              points: rule.points,
              experienceSummaryId,
              gamingXpRuleId: rule.gamingXpRuleId,
              gamingCategoryParticipationPolicyId: policy.gamingCategoryParticipationPolicyId,
              gamingDay,
              reversesGamingXpEventId: null,
              idempotencyKey: `${experienceSummaryId}:PARTICIPATION`,
            });
          }
          // else: no PARTICIPATION rule configured — no applicable
          // consequence, no event, no error.
        }
        // else: allowance exhausted — no event, no error.
      }
      // else: no category participation policy configured at all —
      // no applicable consequence, no event, no error.
    }

    if (summary.performanceBandKey !== null) {
      const rule = this.resolveRule(
        summary.categoryKey,
        "PERFORMANCE",
        summary.performanceBandKey,
        summary.occurredAt
      );
      if (rule && rule.points > 0) {
        const gamingDay = gamingDayFor(summary.occurredAt, "America/Tegucigalpa");
        this.insertXpEvent({
          gamingMemberId: summary.gamingMemberId,
          categoryKey: summary.categoryKey,
          consequenceClass: "PERFORMANCE",
          points: rule.points,
          experienceSummaryId,
          gamingXpRuleId: rule.gamingXpRuleId,
          gamingCategoryParticipationPolicyId: null,
          gamingDay,
          reversesGamingXpEventId: null,
          idempotencyKey: `${experienceSummaryId}:PERFORMANCE`,
        });
      }
    }

    return [...this.xpEvents.values()]
      .filter((e) => e.experienceSummaryId === experienceSummaryId)
      .map((e) => ({
        gamingXpEventId: e.gamingXpEventId,
        consequenceClass: e.consequenceClass,
        points: e.points,
        reversesGamingXpEventId: e.reversesGamingXpEventId,
        alreadyProcessed: false,
      }));
  }

  async getExperienceSummary(experienceSummaryId: string): Promise<ExperienceSummaryRecord | null> {
    return this.summaries.get(experienceSummaryId) ?? null;
  }

  async getExperienceSummaryByIdempotencyKey(
    experienceKey: string,
    idempotencyKey: string
  ): Promise<ExperienceSummaryRecord | null> {
    const id = this.summaryByNaturalKey.get(`${experienceKey}:${idempotencyKey}`);
    return id ? this.summaries.get(id) ?? null : null;
  }

  async listXpEventsForMember(gamingMemberId: string): Promise<GamingXpEventRecord[]> {
    return [...this.xpEvents.values()].filter((e) => e.gamingMemberId === gamingMemberId);
  }

  async listXpEventsForSummary(experienceSummaryId: string): Promise<GamingXpEventRecord[]> {
    return [...this.xpEvents.values()].filter((e) => e.experienceSummaryId === experienceSummaryId);
  }

  async createCategoryParticipationPolicy(input: {
    categoryKey: string;
    dailyParticipationAllowance: number;
    gamingDayTimezone?: string;
  }): Promise<GamingCategoryParticipationPolicyRecord> {
    const record: GamingCategoryParticipationPolicyRecord = {
      gamingCategoryParticipationPolicyId: randomUUID(),
      categoryKey: input.categoryKey,
      dailyParticipationAllowance: input.dailyParticipationAllowance,
      gamingDayTimezone: input.gamingDayTimezone ?? "America/Tegucigalpa",
      effectiveAt: new Date().toISOString(),
      supersededAt: null,
    };
    this.participationPolicies.push(record);
    return record;
  }

  async createGamingXpRule(input: {
    categoryKey: string;
    consequenceClass: ConsequenceClass;
    performanceBandKey: string | null;
    points: number;
  }): Promise<GamingXpRuleRecord> {
    const record: GamingXpRuleRecord = {
      gamingXpRuleId: randomUUID(),
      categoryKey: input.categoryKey,
      consequenceClass: input.consequenceClass,
      performanceBandKey: input.performanceBandKey,
      points: input.points,
      effectiveAt: new Date().toISOString(),
      supersededAt: null,
    };
    this.xpRules.push(record);
    return record;
  }

  /** Test/fixture seam — see the `displayNames` field comment above. */
  registerGamingMemberDisplayName(gamingMemberId: string, displayName: string): void {
    this.displayNames.set(gamingMemberId, displayName);
  }

  async getGlobalLeaderboard(): Promise<GlobalLeaderboardEntry[]> {
    // Reversal-safe with no row-type filtering: a reversal is always
    // inserted as the exact negation of the award it reverses (see
    // insertXpEvent call sites above), so a plain sum over every row —
    // original, reversal, and reissue alike — already nets correctly.
    const totals = new Map<string, number>();
    for (const event of this.xpEvents.values()) {
      totals.set(event.gamingMemberId, (totals.get(event.gamingMemberId) ?? 0) + event.points);
    }

    // Founder-confirmed Product decision: currently-effective Global
    // XP <= 0 (never awarded, or fully reversed to net zero) is
    // excluded — the leaderboard represents current recognized XP,
    // never historical participation evidence.
    const eligible = [...totals.entries()].filter(([, total]) => total > 0);

    // Deterministic ordering: descending by total, then ascending by
    // gamingMemberId as an internal-only secondary key — never
    // returned, never affects the assigned rank itself.
    eligible.sort(([idA, totalA], [idB, totalB]) => {
      if (totalB !== totalA) return totalB - totalA;
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    });

    // Competition ranking (1,1,3): rank advances to the current
    // position only when the total changes from the previous row;
    // tied rows share the previous rank.
    const entries: GlobalLeaderboardEntry[] = [];
    let previousTotal: number | null = null;
    let previousRank = 0;
    eligible.forEach(([gamingMemberId, total], index) => {
      const rank = total === previousTotal ? previousRank : index + 1;
      previousTotal = total;
      previousRank = rank;
      entries.push({
        rank,
        displayName: this.displayNames.get(gamingMemberId) ?? gamingMemberId,
        globalXp: total,
      });
    });

    return entries;
  }
}
