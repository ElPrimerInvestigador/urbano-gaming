import type {
  SessionRepository,
  ResultsRevealedEventRecord,
} from "./db/sessionRepository";
import type { RevealResultsResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  SubmissionsNotClosedError,
} from "./types";

/**
 * REVEAL_RESULTS command handler.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is SUBMISSIONS_CLOSED, and
 * atomically transitions it to RESULT_REVEAL, incrementing
 * state_version and persisting a RESULTS_REVEALED event. Nothing
 * else — no anonymity, voting, ranking, scoring, or winner selection.
 * GET_SESSION is responsible for actually surfacing the submitted
 * responses once this state is reached.
 */
export async function revealResults(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string
): Promise<RevealResultsResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (session.state !== "SUBMISSIONS_CLOSED") {
    throw new SubmissionsNotClosedError(session.state);
  }

  const event: ResultsRevealedEventRecord = {
    sessionId: session.sessionId,
    eventType: "RESULTS_REVEALED",
    payload: {},
  };

  const result = await repo.revealResults(session.sessionId, hostToken, event);

  return {
    sessionId: session.sessionId,
    state: result.state,
    stateVersion: result.stateVersion,
  };
}
