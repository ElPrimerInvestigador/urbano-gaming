import { NextResponse } from "next/server";
import { awardPoints } from "@/lib/session/awardPoints";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  InteractionInstanceNotEligibleError,
  ParticipantNotInSessionError,
  InvalidPointsError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/award-points — AWARD_POINTS
 *
 * Slice 002 (Scored Multi-Round Experience): host-authenticated only,
 * callable while the session is LOBBY_LOCKED and the supplied
 * interactionInstanceId is the session's current, revealed interaction.
 * Idempotent via the required idempotencyKey: a retried request with
 * the same key returns the original result unchanged, even if the
 * session has since progressed — see awardPoints.ts and
 * award_points_atomically for why this route performs no fast-path
 * validation of its own beyond basic type-checking the request body.
 *
 * Route is thin by design, mirroring lock/complete/start/reveal.
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
  let interactionInstanceId: unknown;
  let participantId: unknown;
  let points: unknown;
  let idempotencyKey: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    interactionInstanceId = body?.interactionInstanceId;
    participantId = body?.participantId;
    points = body?.points;
    idempotencyKey = body?.idempotencyKey;
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

  if (typeof interactionInstanceId !== "string" || interactionInstanceId.length === 0) {
    return NextResponse.json(
      { error: "interactionInstanceId is required and must be a string." },
      { status: 400 }
    );
  }

  if (typeof participantId !== "string" || participantId.length === 0) {
    return NextResponse.json(
      { error: "participantId is required and must be a string." },
      { status: 400 }
    );
  }

  if (typeof points !== "number" || !Number.isInteger(points)) {
    return NextResponse.json(
      { error: "points is required and must be an integer." },
      { status: 400 }
    );
  }

  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    return NextResponse.json(
      { error: "idempotencyKey is required and must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await awardPoints(
      repo,
      sessionId,
      hostToken,
      interactionInstanceId,
      participantId,
      points,
      idempotencyKey
    );
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
    if (err instanceof InteractionInstanceNotEligibleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ParticipantNotInSessionError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof InvalidPointsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("AWARD_POINTS failed:", err);
    return NextResponse.json(
      { error: "Failed to award points." },
      { status: 500 }
    );
  }
}
