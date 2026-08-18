import { NextResponse } from "next/server";
import { castVote } from "@/lib/session/castVote";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  SessionAccessDeniedError,
  PromptNotActiveError,
  InvalidCandidateSelectionError,
  SelfVoteNotAllowedError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/cast-vote — CAST_VOTE
 *
 * Slice 007 (Voting Engine). Participant-authenticated only, via
 * Authorization: Bearer — mirrors /submit exactly, including its "no
 * host fallback" rule (the host does not vote in this slice).
 *
 * Route is thin by design: header/body extraction only. All logic
 * lives in castVote(), which is transport-agnostic and unit-tested
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

  let candidateId: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    candidateId = body?.candidateId;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof candidateId !== "string" || candidateId.length === 0) {
    return NextResponse.json(
      { error: "candidateId is required and must be a non-empty string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await castVote(repo, sessionId, participantToken, candidateId);
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
    if (err instanceof InvalidCandidateSelectionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof SelfVoteNotAllowedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("CAST_VOTE failed:", err);
    return NextResponse.json(
      { error: "Failed to cast vote." },
      { status: 500 }
    );
  }
}
