import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildPredictionsRepo } from "@/lib/gaming/predictions/httpAuth";
import { getLeaderboard } from "@/lib/gaming/predictions/leaderboard";

// See matches/route.ts's identical comment: no dynamic segment, no
// request-object access, so this must be forced dynamic to avoid
// static prerendering hitting live Supabase during `next build`.
export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/predictions/leaderboard — public: global Gaming
 * progression ranking, SUM(points) per Gaming Member. No auth
 * required — a leaderboard is inherently public-facing.
 */
export async function GET() {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const repo = buildPredictionsRepo(credentials);
  const leaderboard = await getLeaderboard(repo);
  return NextResponse.json({ leaderboard });
}
