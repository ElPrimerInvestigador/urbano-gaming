import { NextResponse } from "next/server";
import { SupabaseMetagameRepository } from "@/lib/gaming/metagame/db/supabaseMetagameRepository";
import { getGlobalLeaderboard } from "@/lib/gaming/metagame/leaderboard";

// No dynamic segment, no request-object access — must be forced
// dynamic to avoid static prerendering hitting live Supabase during
// `next build`, matching every other credential-backed GET route in
// this codebase (e.g. predictions/leaderboard, predictions/matches).
export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/leaderboard — the canonical Global Gaming XP
 * Leaderboard. Public: no Authorization header, no Gaming Member
 * session, no Gaming Admin requirement — Global Gaming XP and Global
 * rank are public by default per
 * Product/Persistent_Metagame_Architecture.md's privacy boundary.
 *
 * Never lib/gaming/predictions/leaderboard.ts, which is a
 * Predictions-specific, pre-Phase-1 read model over the legacy
 * gaming_progression_events ledger, not this canonical projection.
 */
export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const repo = new SupabaseMetagameRepository(supabaseUrl, supabaseServiceKey);
  const entries = await getGlobalLeaderboard(repo);
  return NextResponse.json({
    entries: entries.map((e) => ({
      rank: e.rank,
      displayName: e.displayName,
      globalXp: e.globalXp,
    })),
  });
}
