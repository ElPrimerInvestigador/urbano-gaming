import { NextResponse } from "next/server";
import { SupabaseGamingRepository } from "../db/supabaseGamingRepository";
import {
  resolveGamingAuth,
  SupabaseAuthUserVerifier,
  isCurrentlyGamingAdmin,
  type GamingAuthState,
} from "../auth";
import { SupabasePredictionsRepository } from "./db/supabasePredictionsRepository";
import {
  MatchNotFoundError,
  MatchCancelledError,
  KickoffPassedError,
  VenueActivationNotFoundError,
  VenueActivationMatchMismatchError,
  VenueActivationDisabledError,
  VenueActivationImmutableError,
  GeoNotEligibleError,
  GeoUnavailableError,
  InvalidPredictionScoreError,
  InvalidGoalMinuteError,
  InvalidFirstTeamError,
  InvalidGoalscorerSelectionError,
  MatchResultNotFoundError,
  NotACorrectionError,
  SupersededResultNotFinalizedError,
  PrizeQualificationNotFoundError,
  QualificationSupersededError,
  InvalidPrizeTierDimensionCountError,
  DraftResultAlreadyExistsError,
  NoFinalizedResultToCorrectError,
  ResultAlreadyBeingCorrectedError,
} from "./types";

/** Maps a known Predictions domain error to its HTTP status; null if unrecognized. */
export function statusForPredictionsError(err: unknown): number | null {
  if (
    err instanceof MatchNotFoundError ||
    err instanceof VenueActivationNotFoundError ||
    err instanceof MatchResultNotFoundError ||
    err instanceof PrizeQualificationNotFoundError
  ) {
    return 404;
  }
  if (
    err instanceof MatchCancelledError ||
    err instanceof KickoffPassedError ||
    err instanceof VenueActivationDisabledError ||
    err instanceof VenueActivationMatchMismatchError ||
    err instanceof VenueActivationImmutableError ||
    err instanceof NotACorrectionError ||
    err instanceof SupersededResultNotFinalizedError ||
    err instanceof QualificationSupersededError ||
    err instanceof DraftResultAlreadyExistsError ||
    err instanceof NoFinalizedResultToCorrectError ||
    err instanceof ResultAlreadyBeingCorrectedError
  ) {
    return 409;
  }
  if (
    err instanceof GeoNotEligibleError ||
    err instanceof GeoUnavailableError ||
    err instanceof InvalidPredictionScoreError ||
    err instanceof InvalidGoalMinuteError ||
    err instanceof InvalidFirstTeamError ||
    err instanceof InvalidGoalscorerSelectionError ||
    err instanceof InvalidPrizeTierDimensionCountError
  ) {
    return 400;
  }
  return null;
}

/** Shared boilerplate every app/api/gaming/predictions/* route needs. */

export function getSupabaseCredentials(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

export function buildPredictionsRepo(credentials: { url: string; serviceKey: string }) {
  return new SupabasePredictionsRepository(credentials.url, credentials.serviceKey);
}

export async function resolveRequestGamingAuth(
  request: Request,
  credentials: { url: string; serviceKey: string }
): Promise<GamingAuthState> {
  const gamingRepo = new SupabaseGamingRepository(credentials.url, credentials.serviceKey);
  const verifier = new SupabaseAuthUserVerifier(credentials.url, credentials.serviceKey);
  return resolveGamingAuth(gamingRepo, verifier, request.headers.get("authorization"));
}

/**
 * Resolves the caller as an authenticated Gaming Member, fresh-checked
 * as a Gaming admin every call — never a JWT claim. Returns either the
 * admin's gamingMemberId or a ready-to-return NextResponse rejection.
 */
export async function requireGamingAdmin(
  request: Request,
  credentials: { url: string; serviceKey: string }
): Promise<{ gamingMemberId: string } | { errorResponse: NextResponse }> {
  const authState = await resolveRequestGamingAuth(request, credentials);

  if (authState.status !== "authenticated") {
    return {
      errorResponse: NextResponse.json(
        { error: "A valid Authorization header for an authenticated Gaming Member is required." },
        { status: 401 }
      ),
    };
  }

  const gamingRepo = new SupabaseGamingRepository(credentials.url, credentials.serviceKey);
  const isAdmin = await isCurrentlyGamingAdmin(gamingRepo, authState.gamingMember.gamingMemberId);
  if (!isAdmin) {
    return {
      errorResponse: NextResponse.json(
        { error: "This action requires Gaming admin authority." },
        { status: 403 }
      ),
    };
  }

  return { gamingMemberId: authState.gamingMember.gamingMemberId };
}

/** Resolves the caller as any authenticated Gaming Member (no admin requirement). */
export async function requireGamingMember(
  request: Request,
  credentials: { url: string; serviceKey: string }
): Promise<{ gamingMemberId: string } | { errorResponse: NextResponse }> {
  const authState = await resolveRequestGamingAuth(request, credentials);
  if (authState.status !== "authenticated") {
    return {
      errorResponse: NextResponse.json(
        { error: "A valid Authorization header for an authenticated Gaming Member is required." },
        { status: 401 }
      ),
    };
  }
  return { gamingMemberId: authState.gamingMember.gamingMemberId };
}
