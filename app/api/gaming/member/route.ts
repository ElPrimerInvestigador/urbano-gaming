import { NextResponse } from "next/server";
import { SupabaseGamingRepository } from "@/lib/gaming/db/supabaseGamingRepository";
import {
  resolveGamingAuth,
  SupabaseAuthUserVerifier,
} from "@/lib/gaming/auth";
import { createGamingMember } from "@/lib/gaming/createGamingMember";
import {
  EmptyGamingDisplayNameError,
  GamingDisplayNameTooLongError,
} from "@/lib/gaming/types";

function getSupabaseCredentials(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

/**
 * GET /api/gaming/member — RESOLVE_GAMING_MEMBER.
 *
 * Requires a verified Authorization: Bearer <access token> header — no
 * Guest-capable path here, unlike the join route, since there is no
 * meaningful "resolve my Gaming Member" request without an
 * authenticated identity to resolve. Returns `{ gamingMember: null }`
 * (200, not an error) when the auth user has not completed profile
 * creation yet — the sign-in UX uses this to decide whether to show
 * the display-name collection step.
 */
export async function GET(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const repo = new SupabaseGamingRepository(
    credentials.url,
    credentials.serviceKey
  );
  const verifier = new SupabaseAuthUserVerifier(
    credentials.url,
    credentials.serviceKey
  );
  const authState = await resolveGamingAuth(
    repo,
    verifier,
    request.headers.get("authorization")
  );

  if (authState.status === "guest" || authState.status === "invalid_token") {
    return NextResponse.json(
      { error: "A valid Authorization header is required." },
      { status: 401 }
    );
  }

  if (authState.status === "profile_incomplete") {
    return NextResponse.json({ gamingMember: null }, { status: 200 });
  }

  return NextResponse.json(
    { gamingMember: authState.gamingMember },
    { status: 200 }
  );
}

/**
 * POST /api/gaming/member — CREATE_GAMING_MEMBER.
 *
 * Requires a verified Authorization header; authUserId is always
 * resolved from that verified token, never from the request body.
 * Idempotent: calling this again for an already-complete profile
 * returns the existing Gaming Member rather than erroring (see
 * createGamingMember's own idempotency guarantee).
 */
export async function POST(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const repo = new SupabaseGamingRepository(
    credentials.url,
    credentials.serviceKey
  );
  const verifier = new SupabaseAuthUserVerifier(
    credentials.url,
    credentials.serviceKey
  );
  const authState = await resolveGamingAuth(
    repo,
    verifier,
    request.headers.get("authorization")
  );

  if (authState.status === "guest" || authState.status === "invalid_token") {
    return NextResponse.json(
      { error: "A valid Authorization header is required." },
      { status: 401 }
    );
  }

  const authUserId =
    authState.status === "authenticated"
      ? authState.gamingMember.authUserId
      : authState.authUserId;

  let displayName: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    displayName = body?.displayName;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof displayName !== "string") {
    return NextResponse.json(
      { error: "displayName is required and must be a string." },
      { status: 400 }
    );
  }

  try {
    const gamingMember = await createGamingMember(repo, authUserId, displayName);
    return NextResponse.json({ gamingMember }, { status: 201 });
  } catch (err) {
    if (
      err instanceof EmptyGamingDisplayNameError ||
      err instanceof GamingDisplayNameTooLongError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("CREATE_GAMING_MEMBER failed:", err);
    return NextResponse.json(
      { error: "Failed to create Gaming Member." },
      { status: 500 }
    );
  }
}
