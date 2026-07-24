import { NextResponse } from "next/server";
import { closeSubmissions } from "@/lib/session/closeSubmissions";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  PromptNotActiveError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/close-submissions — CLOSE_SUBMISSIONS
 *
 * Host-authenticated only, callable only from PROMPT_ACTIVE. Host
 * action explicitly triggers this — no timers, no background jobs.
 * Route is thin by design, mirroring lock/complete/start.
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
    const result = await closeSubmissions(repo, sessionId, hostToken);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof PromptNotActiveError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("CLOSE_SUBMISSIONS failed:", err);
    return NextResponse.json(
      { error: "Failed to close submissions." },
      { status: 500 }
    );
  }
}
