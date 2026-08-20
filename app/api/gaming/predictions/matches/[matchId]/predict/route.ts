import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireGamingMember,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { submitPrediction } from "@/lib/gaming/predictions/submitPrediction";

/**
 * POST /api/gaming/predictions/matches/[matchId]/predict —
 * SUBMIT_PREDICTION. Requires an authenticated Gaming Member; the
 * gamingMemberId is always the verified caller's own — never accepted
 * from the request body. Every call (first submission or a revision)
 * re-verifies geolocation and the kickoff lock. The four Prediction
 * dimensions (scoreline, goalscorer, goal minute, first team to score)
 * are independent — goalscorer/goal minute/first team are each
 * nullable, meaning the member selected "No Goal" for that dimension.
 */
export async function POST(
  request: Request,
  { params }: { params: { matchId: string } }
) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const authResult = await requireGamingMember(request, credentials);
  if ("errorResponse" in authResult) return authResult.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const {
    venueActivationId,
    predictedHomeScore,
    predictedAwayScore,
    predictedGoalscorerPlayerId,
    predictedGoalMinute,
    predictedFirstTeamToScore,
    latitude,
    longitude,
    accuracyMeters,
  } = body;

  if (
    typeof venueActivationId !== "string" ||
    typeof predictedHomeScore !== "number" ||
    typeof predictedAwayScore !== "number" ||
    !(predictedGoalscorerPlayerId === null || typeof predictedGoalscorerPlayerId === "string") ||
    !(predictedGoalMinute === null || typeof predictedGoalMinute === "number") ||
    !(
      predictedFirstTeamToScore === null ||
      predictedFirstTeamToScore === "HOME" ||
      predictedFirstTeamToScore === "AWAY"
    )
  ) {
    return NextResponse.json({ error: "Invalid prediction payload." }, { status: 400 });
  }

  const geo =
    typeof latitude === "number" && typeof longitude === "number"
      ? {
          latitude,
          longitude,
          accuracyMeters: typeof accuracyMeters === "number" ? accuracyMeters : null,
        }
      : null;

  const repo = buildPredictionsRepo(credentials);

  try {
    const prediction = await submitPrediction(repo, {
      matchId: params.matchId,
      gamingMemberId: authResult.gamingMemberId,
      venueActivationId,
      predictedHomeScore,
      predictedAwayScore,
      predictedGoalscorerPlayerId: predictedGoalscorerPlayerId as string | null,
      predictedGoalMinute: predictedGoalMinute as number | null,
      predictedFirstTeamToScore: predictedFirstTeamToScore as "HOME" | "AWAY" | null,
      geo,
    });
    return NextResponse.json({ prediction }, { status: 201 });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) {
      return NextResponse.json({ error: (err as Error).message }, { status });
    }
    console.error("SUBMIT_PREDICTION failed:", err);
    return NextResponse.json({ error: "Failed to submit prediction." }, { status: 500 });
  }
}
