import { NextResponse } from "next/server";
import { submitQuizResponse } from "@/lib/session/submitQuizResponse";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  SessionAccessDeniedError,
  QuizInstanceNotFoundError,
  QuizClosedError,
  InvalidOptionSelectionError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/submit-quiz — SUBMIT_QUIZ_RESPONSE
 *
 * Quiz Experience. Participant-authenticated only, via
 * Authorization: Bearer — mirrors /submit's identical authentication
 * shape. Dedicated route: unlike /submit, this one requires the
 * caller to explicitly name which Quiz question Interaction Instance
 * they are answering, since a Quiz has N simultaneously-active
 * questions and participants progress through them independently.
 *
 * Route is thin by design: header/body extraction only. All logic
 * lives in submitQuizResponse(), transport-agnostic and unit-tested
 * independent of this route.
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

  let interactionInstanceId: unknown;
  let selectedOptionIndex: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    interactionInstanceId = body?.interactionInstanceId;
    selectedOptionIndex = body?.selectedOptionIndex;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (
    typeof interactionInstanceId !== "string" ||
    interactionInstanceId.length === 0
  ) {
    return NextResponse.json(
      { error: "interactionInstanceId is required and must be a string." },
      { status: 400 }
    );
  }

  if (typeof selectedOptionIndex !== "number") {
    return NextResponse.json(
      { error: "selectedOptionIndex is required and must be a number." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await submitQuizResponse(
      repo,
      sessionId,
      participantToken,
      interactionInstanceId,
      selectedOptionIndex
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof QuizInstanceNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof QuizClosedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidOptionSelectionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("SUBMIT_QUIZ_RESPONSE failed:", err);
    return NextResponse.json(
      { error: "Failed to submit Quiz response." },
      { status: 500 }
    );
  }
}
