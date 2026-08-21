import type { MetagameRepository } from "./db/metagameRepository";
import type { RecordExperienceSummaryInput, RecordExperienceSummaryResult } from "./types";

/**
 * RECORD_EXPERIENCE_SUMMARY — the sole write path for a Finalized
 * Experience Summary. Every current Phase 1 caller (Predictions'
 * finalize/correct atomic functions) calls the SQL function this
 * wraps directly, as a nested call within its own transaction, so
 * this thin wrapper is not on that hot path today — it exists for the
 * same reason every command in this codebase gets one: a stable,
 * testable seam, and the call surface a future Experience adapter
 * whose own settlement logic lives in TypeScript (rather than SQL)
 * would use instead of reaching into SQL directly.
 */
export async function recordExperienceSummary(
  repo: MetagameRepository,
  input: RecordExperienceSummaryInput
): Promise<RecordExperienceSummaryResult> {
  return repo.recordExperienceSummary(input);
}
