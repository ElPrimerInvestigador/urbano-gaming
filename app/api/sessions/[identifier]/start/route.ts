import { NextResponse } from "next/server";
import { startSession } from "@/lib/session/startSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  PreviousInteractionNotRevealedError,
  EmptyPromptTextError,
  PromptTextTooLongError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/start — START_SESSION
 *
 * Slice 001 (Session / Interaction separation): host-authenticated
 * only, re-invocable — callable once per interaction, any number of
 * times, as long as the session is LOBBY_LOCKED and its current
 * interaction instance (if any) is already RESULT_REVEAL. Requires
 * host-supplied prompt text on every call; no longer selects from a
 * fixed seeded prompt.
 *
 * The dynamic segment is named [identifier] for the same reason the
 * join/lock/complete/GET routes share it. Route is thin by design:
 * transport concerns only. All logic lives in startSession(), which is
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
  let promptText: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    promptText = body?.promptText;
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

  if (typeof promptText !== "string") {
    return NextResponse.json(
      { error: "promptText is required and must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await startSession(repo, sessionId, hostToken, promptText);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof LobbyNotLockedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof PreviousInteractionNotRevealedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof EmptyPromptTextError ||
      err instanceof PromptTextTooLongError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("START_SESSION failed:", err);
    return NextResponse.json(
      { error: "Failed to start session." },
      { status: 500 }
    );
  }
}
