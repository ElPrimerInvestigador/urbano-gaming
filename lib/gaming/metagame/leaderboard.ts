import type { MetagameRepository } from "./db/metagameRepository";
import type { GlobalLeaderboardEntry } from "./types";

/**
 * GET_GLOBAL_LEADERBOARD — the canonical Global Gaming XP Leaderboard:
 * competition-ranked Gaming Members with currently-effective Global
 * XP > 0, per Product/Persistent_Metagame_Architecture.md's "Global
 * Leaderboard vs. Category Leaderboards". Not lib/gaming/predictions/
 * leaderboard.ts, which remains a Predictions-specific, pre-Phase-1
 * read model over the legacy gaming_progression_events ledger.
 */
export async function getGlobalLeaderboard(repo: MetagameRepository): Promise<GlobalLeaderboardEntry[]> {
  return repo.getGlobalLeaderboard();
}
