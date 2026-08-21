import type { PredictionsRepository } from "./db/predictionsRepository";
import type { LeaderboardEntry } from "./types";

/**
 * GET_LEADERBOARD — Predictions-specific progression ranking, exactly
 * SUM(gaming_progression_events.points) GROUP BY gaming_member_id,
 * pre-dating the Persistent Metagame (Phase 1, ADR-035). This is NOT
 * the canonical Global Gaming XP Leaderboard, despite its own naming
 * history — see Product/Persistent_Metagame_Architecture.md's
 * "Current Predictions Ledger Disposition" and ADR-035's Consequences,
 * both of which name this exact file's "global" wording as
 * implementation-history terminology, not Product authority. The
 * canonical Global leaderboard is
 * lib/gaming/metagame/leaderboard.ts (GET /api/gaming/leaderboard),
 * reading gaming_xp_events, not gaming_progression_events.
 * gaming_progression_events itself receives no new writes as of Phase
 * 1 — finalize/correct now route through the Metagame ledger instead
 * — so this read model is effectively frozen at its pre-Phase-1
 * state, retained rather than deleted per this repository's own
 * practice of not removing working infrastructure without a
 * requirement forcing it.
 */
export async function getLeaderboard(repo: PredictionsRepository): Promise<LeaderboardEntry[]> {
  return repo.getLeaderboard();
}
