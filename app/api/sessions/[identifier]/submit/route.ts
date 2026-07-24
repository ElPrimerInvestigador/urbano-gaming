import { NextResponse } from "next/server";
import { submitResponse } from "@/lib/session/submitResponse";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  SessionAccessDeniedError,
  PromptNotActiveError,
  EmptyResponseError,
  ResponseTooLongError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/submit — SUBMIT_RESPONSE
 *
 * Participant-authenticated only, via Authorization: Bearer — a host
 * token does not authenticate here unless the host is also a joined
 * participant (no host fallback, unlike GET_SESSION).
 *
 * Route is thin by design: header/body extraction only. All logic
 * lives in submitResponse(), which is transport-agnostic and
 * unit-tested independent of this route.
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

  const authHeader = request.headers.get("authorization");
  const bearerMatch = authHeader?.match(/^Bearer (.+)$/i);

  if (!bearerMatch) {
    return NextResponse.json(
      { error: "A Bearer token is required in the Authorization header." },
      { status: 401 }
    );
  }

  const participantToken = bearerMatch[1];

  let text: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    text = body?.text;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof text !== "string") {
    return NextResponse.json(
      { error: "text is required and must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await submitResponse(repo, sessionId, participantToken, text);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof PromptNotActiveError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof EmptyResponseError || err instanceof ResponseTooLongError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("SUBMIT_RESPONSE failed:", err);
    return NextResponse.json(
      { error: "Failed to submit response." },
      { status: 500 }
    );
  }
}
