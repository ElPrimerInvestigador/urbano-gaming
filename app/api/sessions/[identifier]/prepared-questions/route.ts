import { NextResponse } from "next/server";
import { prepareQuestions } from "@/lib/session/prepareQuestions";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import type { PrepareQuestionsInput } from "@/lib/session/types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
  EmptyPromptTextError,
  PromptTextTooLongError,
  InvalidOptionsError,
  InvalidCorrectOptionIndexError,
  InvalidPointsError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/prepared-questions — PREPARE_QUESTIONS
 *
 * Slice 003 (Second Interaction Engine). Host-authenticated only, lets
 * the host author a batch of Multiple Choice questions ahead of
 * running them one at a time via START_SESSION's explicit
 * preparedQuestionId. Callable any time before SESSION_COMPLETE — no
 * specific positive session state is required, unlike most other
 * write commands in this codebase.
 *
 * Route is thin by design, mirroring every other write route here.
 * Body-shape validation below is deliberately minimal (types only);
 * prepareQuestions() performs the actual content validation.
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
  let questions: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    questions = body?.questions;
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

  if (!Array.isArray(questions) || questions.length === 0) {
    return NextResponse.json(
      { error: "questions is required and must be a non-empty array." },
      { status: 400 }
    );
  }

  const parsedQuestions: PrepareQuestionsInput[] = [];
  for (const raw of questions) {
    const q = raw as Record<string, unknown>;
    if (
      typeof q?.promptText !== "string" ||
      !Array.isArray(q?.options) ||
      !q.options.every((option: unknown) => typeof option === "string") ||
      typeof q?.correctOptionIndex !== "number" ||
      (q.points !== undefined && typeof q.points !== "number")
    ) {
      return NextResponse.json(
        {
          error:
            "Each question requires promptText (string), options (string[]), correctOptionIndex (number), and an optional points (number).",
        },
        { status: 400 }
      );
    }

    parsedQuestions.push({
      promptText: q.promptText,
      options: q.options as string[],
      correctOptionIndex: q.correctOptionIndex,
      points: q.points as number | undefined,
    });
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await prepareQuestions(
      repo,
      sessionId,
      hostToken,
      parsedQuestions
    );
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
    if (
      err instanceof EmptyPromptTextError ||
      err instanceof PromptTextTooLongError ||
      err instanceof InvalidOptionsError ||
      err instanceof InvalidCorrectOptionIndexError ||
      err instanceof InvalidPointsError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("PREPARE_QUESTIONS failed:", err);
    return NextResponse.json(
      { error: "Failed to prepare questions." },
      { status: 500 }
    );
  }
}
