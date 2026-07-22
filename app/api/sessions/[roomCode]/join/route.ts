import { NextResponse } from "next/server";
import { joinSession } from "@/lib/session/joinSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  LobbyNotOpenError,
  DisplayNameTakenError,
  EmptyDisplayNameError,
  DisplayNameTooLongError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[roomCode]/join — JOIN_SESSION
 *
 * Route is thin by design, mirroring /api/sessions: transport concerns
 * only. All logic lives in joinSession(), which is transport-agnostic
 * and unit-tested independent of this route.
 */
export async function POST(
  request: Request,
  { params }: { params: { roomCode: string } }
) {
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

  if (typeof displayName !== "string") {
    return NextResponse.json(
      { error: "displayName is required and must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await joinSession(repo, params.roomCode, displayName);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof LobbyNotOpenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof DisplayNameTakenError) {
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
