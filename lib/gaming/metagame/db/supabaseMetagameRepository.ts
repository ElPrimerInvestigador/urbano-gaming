import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  ActivityClassification,
  AuthorityTier,
} from "../types";
import {
  InvalidActivityClassificationError,
  InvalidAuthorityTierError,
  ExperienceSummaryNotFoundError,
} from "../types";

function translateNamedError(error: { code?: string; message?: string }): Error | null {
  if (error.code !== "P0001" || typeof error.message !== "string") return null;
  const table: Array<[string, () => Error]> = [
    ["INVALID_ACTIVITY_CLASSIFICATION", () => new InvalidActivityClassificationError()],
    ["INVALID_AUTHORITY_TIER", () => new InvalidAuthorityTierError()],
    ["EXPERIENCE_SUMMARY_NOT_FOUND", () => new ExperienceSummaryNotFoundError()],
  ];
  for (const [code, build] of table) {
    if (error.message.includes(code)) return build();
  }
  return null;
}

function mapSummary(row: any): ExperienceSummaryRecord {
  return {
    experienceSummaryId: row.experience_summary_id,
    gamingMemberId: row.gaming_member_id,
    experienceKey: row.experience_key,
    categoryKey: row.category_key,
    activityClassification: row.activity_classification,
    authorityTier: row.authority_tier,
    occurredAt: row.occurred_at,
    finalizedAt: row.finalized_at,
    meaningfulParticipation: row.meaningful_participation,
    performanceBandKey: row.performance_band_key,
    sourceReference: row.source_reference,
    rulesetVersion: row.ruleset_version,
    supersedesExperienceSummaryId: row.supersedes_experience_summary_id,
    idempotencyKey: row.idempotency_key,
    evidence: row.evidence ?? {},
    correctDimensionCount: row.correct_dimension_count ?? null,
    correctDimensionKeys: row.correct_dimension_keys ?? null,
    xpEligible: row.xp_eligible,
    createdAt: row.created_at,
  };
}

function mapXpEvent(row: any): GamingXpEventRecord {
  return {
    gamingXpEventId: row.gaming_xp_event_id,
    gamingMemberId: row.gaming_member_id,
    categoryKey: row.category_key,
    consequenceClass: row.consequence_class,
    points: row.points,
    experienceSummaryId: row.experience_summary_id,
    gamingXpRuleId: row.gaming_xp_rule_id,
    gamingCategoryParticipationPolicyId: row.gaming_category_participation_policy_id,
    gamingDay: row.gaming_day,
    reversesGamingXpEventId: row.reverses_gaming_xp_event_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

/**
 * Persistent Metagame — real Postgres implementation. Every write
 * goes through record_experience_summary_atomically /
 * process_experience_summary_consequences_atomically (0089/0090) —
 * this class never constructs a direct insert against
 * gaming_xp_events, gaming_xp_rules, or
 * gaming_category_participation_policy for the write path; only the
 * two test/fixture-seam methods insert directly, and only into the
 * two config tables Phase 1 deliberately leaves without an admin
 * route.
 */
export class SupabaseMetagameRepository implements MetagameRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, cache: "no-store" } as RequestInit),
      },
    });
  }

  async recordExperienceSummary(input: RecordExperienceSummaryInput): Promise<RecordExperienceSummaryResult> {
    const { data, error } = await this.client.rpc("record_experience_summary_atomically", {
      p_gaming_member_id: input.gamingMemberId,
      p_experience_key: input.experienceKey,
      p_category_key: input.categoryKey,
      p_activity_classification: input.activityClassification,
      p_authority_tier: input.authorityTier,
      p_occurred_at: input.occurredAt,
      p_finalized_at: input.finalizedAt,
      p_meaningful_participation: input.meaningfulParticipation,
      p_performance_band_key: input.performanceBandKey,
      p_source_reference: input.sourceReference,
      p_ruleset_version: input.rulesetVersion,
      p_supersedes_experience_summary_id: input.supersedesExperienceSummaryId,
      p_idempotency_key: input.idempotencyKey,
      p_evidence: input.evidence,
      p_correct_dimension_count: input.correctDimensionCount ?? null,
      p_correct_dimension_keys: input.correctDimensionKeys ?? null,
      p_xp_eligible: input.xpEligible ?? false,
    });

    if (error) {
      const translated = translateNamedError(error);
      throw translated ?? error;
    }

    const row = data[0];
    return { experienceSummaryId: row.experience_summary_id, alreadyRecorded: row.already_recorded };
  }

  async processExperienceSummaryConsequences(experienceSummaryId: string): Promise<ProcessedConsequence[]> {
    const { data, error } = await this.client.rpc("process_experience_summary_consequences_atomically", {
      p_experience_summary_id: experienceSummaryId,
    });

    if (error) {
      const translated = translateNamedError(error);
      throw translated ?? error;
    }

    return (data as any[]).map((row) => ({
      gamingXpEventId: row.gaming_xp_event_id,
      consequenceClass: row.consequence_class,
      points: row.points,
      reversesGamingXpEventId: row.reverses_gaming_xp_event_id,
      alreadyProcessed: row.already_processed,
    }));
  }

  async getExperienceSummary(experienceSummaryId: string): Promise<ExperienceSummaryRecord | null> {
    const { data, error } = await this.client
      .from("experience_summaries")
      .select("*")
      .eq("experience_summary_id", experienceSummaryId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapSummary(data) : null;
  }

  async getExperienceSummaryByIdempotencyKey(
    experienceKey: string,
    idempotencyKey: string
  ): Promise<ExperienceSummaryRecord | null> {
    const { data, error } = await this.client
      .from("experience_summaries")
      .select("*")
      .eq("experience_key", experienceKey)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    return data ? mapSummary(data) : null;
  }

  async listXpEventsForMember(gamingMemberId: string): Promise<GamingXpEventRecord[]> {
    const { data, error } = await this.client
      .from("gaming_xp_events")
      .select("*")
      .eq("gaming_member_id", gamingMemberId);
    if (error) throw error;
    return (data ?? []).map(mapXpEvent);
  }

  async listXpEventsForSummary(experienceSummaryId: string): Promise<GamingXpEventRecord[]> {
    const { data, error } = await this.client
      .from("gaming_xp_events")
      .select("*")
      .eq("experience_summary_id", experienceSummaryId);
    if (error) throw error;
    return (data ?? []).map(mapXpEvent);
  }

  async createCategoryParticipationPolicy(input: {
    categoryKey: string;
    dailyParticipationAllowance: number;
    gamingDayTimezone?: string;
  }): Promise<GamingCategoryParticipationPolicyRecord> {
    const { data, error } = await this.client
      .from("gaming_category_participation_policy")
      .insert({
        category_key: input.categoryKey,
        daily_participation_allowance: input.dailyParticipationAllowance,
        gaming_day_timezone: input.gamingDayTimezone ?? "America/Tegucigalpa",
      })
      .select()
      .single();
    if (error) throw error;
    return {
      gamingCategoryParticipationPolicyId: data.gaming_category_participation_policy_id,
      categoryKey: data.category_key,
      dailyParticipationAllowance: data.daily_participation_allowance,
      gamingDayTimezone: data.gaming_day_timezone,
      effectiveAt: data.effective_at,
      supersededAt: data.superseded_at,
    };
  }

  async createGamingXpRule(input: {
    categoryKey: string;
    consequenceClass: ConsequenceClass;
    performanceBandKey: string | null;
    points: number;
  }): Promise<GamingXpRuleRecord> {
    const { data, error } = await this.client
      .from("gaming_xp_rules")
      .insert({
        category_key: input.categoryKey,
        consequence_class: input.consequenceClass,
        performance_band_key: input.performanceBandKey,
        points: input.points,
      })
      .select()
      .single();
    if (error) throw error;
    return {
      gamingXpRuleId: data.gaming_xp_rule_id,
      categoryKey: data.category_key,
      consequenceClass: data.consequence_class,
      performanceBandKey: data.performance_band_key,
      points: data.points,
      effectiveAt: data.effective_at,
      supersededAt: data.superseded_at,
    };
  }

  async getGlobalLeaderboard(): Promise<GlobalLeaderboardEntry[]> {
    // Delegates aggregation and competition ranking entirely to
    // Postgres via get_global_gaming_xp_leaderboard() (0093) — never a
    // raw multi-row gaming_xp_events select, which PostgREST's
    // configured max_rows silently truncates once the ledger exceeds
    // it (empirically confirmed during the readiness gate). The
    // function's own output is one row per Gaming Member currently at
    // positive Global XP, not one row per event, so it stays correct
    // at a materially larger scale than a raw event select would.
    const { data, error } = await this.client.rpc("get_global_gaming_xp_leaderboard");
    if (error) throw error;
    return (data ?? []).map((row: any) => ({
      rank: row.global_rank,
      displayName: row.display_name,
      globalXp: row.total_xp,
    }));
  }
}

// Re-exported for callers that only need the type-level shape.
export type { ActivityClassification, AuthorityTier };
