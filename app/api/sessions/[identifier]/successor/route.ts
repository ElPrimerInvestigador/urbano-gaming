import { NextResponse } from "next/server";
import { createSuccessorSession } from "@/lib/session/createSuccessorSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  PredecessorSessionNotCompleteError,
  PredecessorAlreadyHasSuccessorError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/successor — CREATE_SUCCESSOR_SESSION
 *
 * Session Continuity slice. [identifier] is the *predecessor*
 * session's id — the completed session the host is creating a
 * rematch from, not the new session (which doesn't exist until this
 * call succeeds). Host-authenticated against that predecessor.
 *
 * Route is thin by design, mirroring complete/route.ts: transport
 * concerns only. All logic lives in createSuccessorSession(), which is
 * transport-agnostic and unit-tested independent of this route.
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  const predecessorSessionId = params.identifier;

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
    const result = await createSuccessorSession(
      repo,
      predecessorSessionId,
      hostToken
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof PredecessorSessionNotCompleteError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof PredecessorAlreadyHasSuccessorError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("CREATE_SUCCESSOR_SESSION failed:", err);
    return NextResponse.json(
      { error: "Failed to create successor session." },
      { status: 500 }
    );
  }
}
