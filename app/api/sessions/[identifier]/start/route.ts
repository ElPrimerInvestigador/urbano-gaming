import { NextResponse } from "next/server";
import { startSession } from "@/lib/session/startSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import type { VotingCandidateSource, SegmentTarget } from "@/lib/session/types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  PreviousInteractionNotRevealedError,
  NoCurrentSegmentToContinueError,
  EmptyPromptTextError,
  PromptTextTooLongError,
  PreparedQuestionNotFoundError,
  PreparedQuestionAlreadyConsumedError,
  InvalidVotingCandidatesError,
  VotingSourceInteractionNotFoundError,
  VotingSourceInteractionNotEligibleError,
  AmbiguousStartSessionTargetError,
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
 * Slice 003 (Second Interaction Engine): an optional preparedQuestionId
 * starts a specific, previously-authored Multiple Choice question
 * instead. When supplied, promptText is not required.
 *
 * Slice 007 (Voting Engine): an optional votingCandidateSource starts a
 * Voting interaction instead — either { type: "HOST_AUTHORED", candidates }
 * or { type: "SUBMISSION", sourceInteractionInstanceId }. Mutually
 * exclusive with preparedQuestionId; promptText IS still required for
 * both Voting sub-cases, unlike the prepared-question path.
 *
 * Slice 008 (Segment / Turn grouping): an optional segmentTarget —
 * "NEW_SEGMENT" (default when omitted) or "CURRENT_SEGMENT" — selects
 * whether this Interaction Instance starts a new member-facing Turn or
 * joins the session's existing current one. Omitting it entirely
 * reproduces every pre-Slice-008 client's exact behavior.
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
  let preparedQuestionId: unknown;
  let votingCandidateSource: unknown;
  let segmentTarget: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    promptText = body?.promptText;
    preparedQuestionId = body?.preparedQuestionId;
    votingCandidateSource = body?.votingCandidateSource;
    segmentTarget = body?.segmentTarget;
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

  if (
    preparedQuestionId !== undefined &&
    preparedQuestionId !== null &&
    (typeof preparedQuestionId !== "string" || preparedQuestionId.length === 0)
  ) {
    return NextResponse.json(
      { error: "preparedQuestionId, if supplied, must be a non-empty string." },
      { status: 400 }
    );
  }

  const hasPreparedQuestionId =
    typeof preparedQuestionId === "string" && preparedQuestionId.length > 0;

  // Slice 007 (Voting Engine): minimal shape validation only — deep
  // validation (candidate count/emptiness, source-interaction
  // eligibility) is startSession()'s and the repository's job, not the
  // route's, matching every other command here.
  let normalizedVotingCandidateSource: VotingCandidateSource | null = null;
  if (votingCandidateSource !== undefined && votingCandidateSource !== null) {
    const source = votingCandidateSource as Record<string, unknown>;
    if (
      source.type === "HOST_AUTHORED" &&
      Array.isArray(source.candidates) &&
      source.candidates.every((c) => typeof c === "string")
    ) {
      normalizedVotingCandidateSource = {
        type: "HOST_AUTHORED",
        candidates: source.candidates as string[],
      };
    } else if (
      source.type === "SUBMISSION" &&
      typeof source.sourceInteractionInstanceId === "string" &&
      source.sourceInteractionInstanceId.length > 0
    ) {
      normalizedVotingCandidateSource = {
        type: "SUBMISSION",
        sourceInteractionInstanceId: source.sourceInteractionInstanceId,
      };
    } else {
      return NextResponse.json(
        {
          error:
            'votingCandidateSource, if supplied, must be { type: "HOST_AUTHORED", candidates: string[] } or { type: "SUBMISSION", sourceInteractionInstanceId: string }.',
        },
        { status: 400 }
      );
    }
  }

  if (
    segmentTarget !== undefined &&
    segmentTarget !== null &&
    segmentTarget !== "NEW_SEGMENT" &&
    segmentTarget !== "CURRENT_SEGMENT"
  ) {
    return NextResponse.json(
      {
        error:
          'segmentTarget, if supplied, must be "NEW_SEGMENT" or "CURRENT_SEGMENT".',
      },
      { status: 400 }
    );
  }

  const normalizedSegmentTarget: SegmentTarget =
    segmentTarget === "CURRENT_SEGMENT" ? "CURRENT_SEGMENT" : "NEW_SEGMENT";

  if (
    !hasPreparedQuestionId &&
    !normalizedVotingCandidateSource &&
    typeof promptText !== "string"
  ) {
    return NextResponse.json(
      {
        error:
          "promptText is required and must be a string, unless preparedQuestionId is supplied.",
      },
      { status: 400 }
    );
  }

  if (normalizedVotingCandidateSource && typeof promptText !== "string") {
    return NextResponse.json(
      { error: "promptText is required and must be a string for a Voting interaction." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await startSession(
      repo,
      sessionId,
      hostToken,
      typeof promptText === "string" ? promptText : "",
      hasPreparedQuestionId ? (preparedQuestionId as string) : null,
      normalizedVotingCandidateSource,
      normalizedSegmentTarget
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
    if (err instanceof PreviousInteractionNotRevealedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof NoCurrentSegmentToContinueError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof EmptyPromptTextError ||
      err instanceof PromptTextTooLongError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof PreparedQuestionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PreparedQuestionAlreadyConsumedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof AmbiguousStartSessionTargetError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof InvalidVotingCandidatesError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof VotingSourceInteractionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof VotingSourceInteractionNotEligibleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("START_SESSION failed:", err);
    return NextResponse.json(
      { error: "Failed to start session." },
      { status: 500 }
    );
  }
}
