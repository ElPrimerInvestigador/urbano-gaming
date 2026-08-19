import type { SessionRepository } from "./db/sessionRepository";
import type { StartQuizResult } from "./types";
import { InvalidQuizDurationError } from "./types";

const MIN_QUIZ_DURATION_SECONDS = 30;
const MAX_QUIZ_DURATION_SECONDS = 3600;

/**
 * Validates a host-supplied Quiz duration per the accepted
 * implementation-readiness design's bound: 30 seconds to one hour, a
 * conservative proving-case range. Mirrors startSession.ts's own
 * validateAndTrimPromptText — a pure input check that fails fast,
 * domain-side, before spending a round trip on the atomic operation
 * that re-validates it authoritatively regardless (see
 * start_quiz_atomically's own defense-in-depth check).
 */
function validateDurationSeconds(durationSeconds: number): number {
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < MIN_QUIZ_DURATION_SECONDS ||
    durationSeconds > MAX_QUIZ_DURATION_SECONDS
  ) {
    throw new InvalidQuizDurationError();
  }
  return durationSeconds;
}

/**
 * START_QUIZ command handler.
 *
 * Quiz Experience (self-paced, independent participant progression —
 * distinct from Trivia). Dedicated command, not a generalization of
 * START_SESSION — see this platform's implementation-readiness design
 * for why. Scope: authenticates the caller as the session's host,
 * verifies the session is LOBBY_LOCKED with no un-revealed current
 * interaction, creates one new Segment, computes a database-
 * authoritative closesAt from the supplied duration, and consumes
 * every currently-unconsumed prepared question for this session into
 * its own new Multiple Choice Interaction Instance — all created
 * PROMPT_ACTIVE together, never lazily. All of this happens inside
 * startQuiz's own atomic repository operation; this handler itself
 * performs no separate reads or writes beyond the one call below.
 */
export async function startQuiz(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  durationSeconds: number
): Promise<StartQuizResult> {
  const validatedDuration = validateDurationSeconds(durationSeconds);

  const result = await repo.startQuiz(sessionId, hostToken, validatedDuration);

  return {
    sessionId,
    segmentId: result.segmentId,
    segmentNumber: result.segmentOrdinal,
    closesAt: result.closesAt,
    totalQuestions: result.interactionInstanceIds.length,
  };
}
