import type { PredictionsRepository } from "./db/predictionsRepository";

/**
 * FINALIZE_CORRECTION — the correction counterpart to
 * finalizeMatchResult. matchResultId must already be a draft created
 * with supersedesMatchResultId set (via saveDraftResult in
 * adminCatalog.ts) — all compensation/supersession logic lives inside
 * correct_match_result_atomically itself.
 */
export async function correctMatchResult(
  repo: PredictionsRepository,
  matchResultId: string,
  finalizedByGamingMemberId: string
): Promise<{
  matchResultId: string;
  finalizedAt: string;
  supersedesMatchResultId: string;
  alreadyFinalized: boolean;
}> {
  return repo.correctMatchResult(matchResultId, finalizedByGamingMemberId);
}
