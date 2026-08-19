import { NextResponse } from "next/server";
import { closeQuiz } from "@/lib/session/closeQuiz";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  QuizNotFoundError,
  QuizAccessDeniedError,
  QuizExpiryNotReachedError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/close-quiz — CLOSE_QUIZ
 *
 * Quiz Experience. Unlike every other write route in this app (host-
 * only, or participant-only), this one is dual-authority by design:
 * `callerToken` may be either the session's host token (always
 * authorized to close early) or any participant token of this session
 * (authorized only once the deadline has actually passed). It is
 * accepted as a body field rather than an Authorization: Bearer header
 * specifically because it is not scoped to one role the way every
 * other route's bearer token is — see closeQuiz.ts's own comment for
 * the full authority split, resolved authoritatively inside the
 * repository's atomic operation, not by this route.
 *
 * Idempotent: a second call after the Quiz is already closed returns
 * 200 with alreadyClosed: true, not an error — safe for multiple
 * clients to call after independently noticing the deadline has
 * passed.
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

  let segmentId: unknown;
  let callerToken: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    segmentId = body?.segmentId;
    callerToken = body?.callerToken;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof segmentId !== "string" || segmentId.length === 0) {
    return NextResponse.json(
      { error: "segmentId is required and must be a string." },
      { status: 400 }
    );
  }

  if (typeof callerToken !== "string" || callerToken.length === 0) {
    return NextResponse.json(
      { error: "callerToken is required and must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await closeQuiz(repo, sessionId, segmentId, callerToken);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof QuizNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof QuizAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof QuizExpiryNotReachedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("CLOSE_QUIZ failed:", err);
    return NextResponse.json({ error: "Failed to close Quiz." }, { status: 500 });
  }
}
