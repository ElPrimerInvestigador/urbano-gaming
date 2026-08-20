import type { PredictionsRepository } from "./db/predictionsRepository";

/**
 * FINALIZE_RESULT — the authoritative settlement boundary for a
 * Match's first Result. All settlement logic (evaluation, progression
 * awarding, prize qualification) lives inside
 * finalize_match_result_atomically itself, transactionally — this
 * wrapper exists only for the same reason every other command in this
 * codebase gets one: a stable, testable seam between the API route and
 * the repository.
 */
export async function finalizeMatchResult(
  repo: PredictionsRepository,
  matchResultId: string,
  finalizedByGamingMemberId: string
): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }> {
  return repo.finalizeMatchResult(matchResultId, finalizedByGamingMemberId);
}
