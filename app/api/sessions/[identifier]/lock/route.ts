import { NextResponse } from "next/server";
import { lockLobby } from "@/lib/session/lockLobby";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotOpenError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/lock — LOCK_LOBBY
 *
 * The dynamic segment is named [identifier] (not [sessionId]) because
 * Next.js requires one shared slug name across all routes at the same
 * path position — /api/sessions/[identifier]/join also occupies it.
 * For this route, the value is the session id.
 *
 * Host-authenticated only, via the host token issued at CREATE_SESSION.
 * Route is thin by design, mirroring the existing session routes:
 * transport concerns only. All logic lives in lockLobby(), which is
 * transport-agnostic and unit-tested independent of this route.
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  const sessionId = params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  let hostToken: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof hostToken !== "string" || hostToken.length === 0) {
    return NextResponse.json(
      { error: "hostToken is required and must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await lockLobby(repo, sessionId, hostToken);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof LobbyNotOpenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("LOCK_LOBBY failed:", err);
    return NextResponse.json(
      { error: "Failed to lock lobby." },
      { status: 500 }
    );
  }
}
