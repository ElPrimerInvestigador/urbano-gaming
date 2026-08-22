import { NextResponse } from "next/server";
import { joinSession } from "@/lib/session/joinSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  LobbyNotOpenError,
  DisplayNameTakenError,
  EmptyDisplayNameError,
  DisplayNameTooLongError,
  GamingMemberAlreadyInSessionError,
  SessionCapabilitiesNotDeclaredError,
} from "@/lib/session/types";
import { SupabaseGamingRepository } from "@/lib/gaming/db/supabaseGamingRepository";
import {
  resolveGamingAuth,
  SupabaseAuthUserVerifier,
} from "@/lib/gaming/auth";

/**
 * POST /api/sessions/[identifier]/join — JOIN_SESSION
 *
 * The dynamic segment is named [identifier] (not [roomCode]) because
 * Next.js requires one shared slug name across all routes at the same
 * path position — /api/sessions/[identifier]/lock also occupies it.
 * For this route, the value is the room code.
 *
 * Route is thin by design, mirroring /api/sessions: transport concerns
 * only. All Session logic lives in joinSession(), which is
 * transport-agnostic and unit-tested independent of this route.
 *
 * URBANO Gaming Identity Foundation — additive Authorization handling:
 * No Authorization header at all -> the exact pre-existing Guest path,
 * byte-for-byte unchanged (displayName required from the body, no
 * Gaming Member linkage, joinSession's own default parameter keeps
 * this branch identical to how it always behaved).
 *
 * A present Authorization header switches this request onto the
 * authenticated path: the token is verified against Supabase Auth
 * itself (never trusted from the body), the caller's Gaming Member is
 * resolved, and a genuinely incomplete profile is rejected outright —
 * there is no "join as a half-authenticated Guest" fallback. A
 * completed Gaming Member's own display_name becomes the default
 * Session display name; the body's displayName, if supplied and
 * non-empty, overrides it for this Session only (the persistent
 * Gaming Member display_name itself is never modified by this route).
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  const roomCode = params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

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

  const gamingRepo = new SupabaseGamingRepository(
    supabaseUrl,
    supabaseServiceKey
  );
  const verifier = new SupabaseAuthUserVerifier(
    supabaseUrl,
    supabaseServiceKey
  );
  const authState = await resolveGamingAuth(
    gamingRepo,
    verifier,
    request.headers.get("authorization")
  );

  let effectiveDisplayName: string;
  let gamingMemberId: string | null = null;

  if (authState.status === "guest") {
    if (typeof displayName !== "string") {
      return NextResponse.json(
        { error: "displayName is required and must be a string." },
        { status: 400 }
      );
    }
    effectiveDisplayName = displayName;
  } else if (authState.status === "invalid_token") {
    return NextResponse.json(
      { error: "Invalid or expired authentication token." },
      { status: 401 }
    );
  } else if (authState.status === "profile_incomplete") {
    return NextResponse.json(
      {
        error:
          "Gaming Member profile must be completed before joining a session.",
      },
      { status: 403 }
    );
  } else {
    const override =
      typeof displayName === "string" && displayName.trim().length > 0
        ? displayName
        : null;
    effectiveDisplayName = override ?? authState.gamingMember.displayName;
    gamingMemberId = authState.gamingMember.gamingMemberId;
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await joinSession(
      repo,
      roomCode,
      effectiveDisplayName,
      gamingMemberId
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof LobbyNotOpenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof SessionCapabilitiesNotDeclaredError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof DisplayNameTakenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof GamingMemberAlreadyInSessionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof EmptyDisplayNameError ||
      err instanceof DisplayNameTooLongError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("JOIN_SESSION failed:", err);
    return NextResponse.json(
      { error: "Failed to join session." },
      { status: 500 }
    );
  }
}
