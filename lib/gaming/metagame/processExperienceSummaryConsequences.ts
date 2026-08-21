import type { MetagameRepository } from "./db/metagameRepository";
import type { ProcessedConsequence } from "./types";

/**
 * PROCESS_EXPERIENCE_SUMMARY_CONSEQUENCES — the only place a
 * Finalized Experience Summary's normalized facts are ever read
 * against gaming_xp_rules / gaming_category_participation_policy to
 * decide an XP consequence. No Experience adapter may perform this
 * lookup itself — see this seam's own SQL migration comment (0090)
 * for the full boundary reasoning.
 */
export async function processExperienceSummaryConsequences(
  repo: MetagameRepository,
  experienceSummaryId: string
): Promise<ProcessedConsequence[]> {
  return repo.processExperienceSummaryConsequences(experienceSummaryId);
}
