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
 * Slice 001 (Session / Interaction separation): scope moves from the
 * session's own state to the session's current interaction instance.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is LOBBY_LOCKED and its current
 * interaction instance is SUBMISSIONS_CLOSED, and atomically
 * transitions that interaction instance to RESULT_REVEAL, persisting
 * a RESULTS_REVEALED event. Nothing else — no anonymity, voting,
 * ranking, scoring, or winner selection. GET_SESSION is responsible
 * for actually surfacing the submitted responses once this state is
 * reached.
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

  const interactionInstances = await repo.getInteractionInstancesForSession(
    sessionId
  );
  const currentInteraction =
    interactionInstances.length > 0
      ? interactionInstances[interactionInstances.length - 1]
      : null;

  if (
    session.state !== "LOBBY_LOCKED" ||
    !currentInteraction ||
    currentInteraction.state !== "SUBMISSIONS_CLOSED"
  ) {
    throw new SubmissionsNotClosedError(currentInteraction?.state);
  }

  const event: ResultsRevealedEventRecord = {
    sessionId: session.sessionId,
    eventType: "RESULTS_REVEALED",
    payload: {},
  };

  const result = await repo.revealResults(session.sessionId, hostToken, event);

  return {
    sessionId: session.sessionId,
    interactionInstanceId: result.interactionInstanceId,
    state: result.state,
  };
}
