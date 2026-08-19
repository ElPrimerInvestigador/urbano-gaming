import type { SessionRepository } from "./db/sessionRepository";
import type { CloseQuizResult } from "./types";

/**
 * CLOSE_QUIZ command handler.
 *
 * Quiz Experience. Dedicated command, not a generalization of
 * REVEAL_RESULTS — evaluates and reveals every question in the Quiz
 * Segment together, in one call, rather than one Interaction Instance
 * at a time.
 *
 * Unlike every other write command in this codebase (host-only, or
 * participant-only), this one is dual-authority by design: callerToken
 * may be either the session's host token (always authorized to close
 * early) or any participant token of this session (authorized only
 * once the Quiz's deadline has actually passed — see the accepted
 * implementation-readiness design's Seam-adjacent reasoning for why a
 * participant may trigger automatic expiry but never force an early
 * close). All of that authority resolution happens inside the
 * repository's own atomic operation; this handler performs no
 * separate check.
 *
 * Idempotent: a second call after the Quiz is already closed returns
 * the same closedAt with alreadyClosed: true, performing no further
 * work — safe to call from multiple simultaneous clients that each
 * notice the deadline has passed, or from a benign host-close/
 * expiry-close race.
 */
export async function closeQuiz(
  repo: SessionRepository,
  sessionId: string,
  segmentId: string,
  callerToken: string
): Promise<CloseQuizResult> {
  const result = await repo.closeQuiz(sessionId, segmentId, callerToken);

  return {
    sessionId,
    segmentId: result.segmentId,
    closedAt: result.closedAt,
    alreadyClosed: result.alreadyClosed,
  };
}
