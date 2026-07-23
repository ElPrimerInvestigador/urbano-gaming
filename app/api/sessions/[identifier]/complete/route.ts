import { NextResponse } from "next/server";
import { completeSession } from "@/lib/session/completeSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/complete — COMPLETE_SESSION
 *
 * Interpretation 2 (administrative termination): host-authenticated,
 * callable from any state except SESSION_COMPLETE itself — not
 * restricted to a single required source state the way LOCK_LOBBY is.
 *
 * The dynamic segment is named [identifier] for the same reason the
 * join/lock/GET routes share it. Route is thin by design: transport
 * concerns only. All logic lives in completeSession(), which is
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
    const result = await completeSession(repo, sessionId, hostToken);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof SessionAlreadyCompleteError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("COMPLETE_SESSION failed:", err);
    return NextResponse.json(
      { error: "Failed to complete session." },
      { status: 500 }
    );
  }
}
