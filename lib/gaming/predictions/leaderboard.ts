import type { PredictionsRepository } from "./db/predictionsRepository";
import type { LeaderboardEntry } from "./types";

/**
 * GET_LEADERBOARD — global Gaming progression ranking, exactly
 * SUM(gaming_progression_events.points) GROUP BY gaming_member_id. No
 * seasons, circles, venue ranking, or by-game filtering — the smallest
 * read model the proving case needs, ready for the existing
 * Leaderboards surface to consume when wired up.
 */
export async function getLeaderboard(repo: PredictionsRepository): Promise<LeaderboardEntry[]> {
  return repo.getLeaderboard();
}
