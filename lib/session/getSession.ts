import type { SessionRepository } from "./db/sessionRepository";
import type { GetSessionResult } from "./types";
import { SessionNotFoundError, SessionAccessDeniedError } from "./types";

/**
 * GET_SESSION command handler.
 *
 * Scope: returns current session state, state_version, and the
 * participant list (display names only — never a hostToken or any
 * participantToken). Read-only, no state mutation, no event write.
 *
 * Authorization: unlike LOCK_LOBBY's write-time authorization, there is
 * no concurrent-mutation race to close here — two reads cannot conflict
 * with each other. So the bearer token is checked once, in this domain
 * function, against the session's host token and every participant's
 * token, with no need for a repository-level atomic re-check.
 */
export async function getSession(
  repo: SessionRepository,
  sessionId: string,
  bearerToken: string
): Promise<GetSessionResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  const participants = await repo.getParticipantsForSession(sessionId);

  const isHost = bearerToken === session.hostToken;
  const isParticipant = participants.some(
    (participant) => participant.participantToken === bearerToken
  );

  if (!isHost && !isParticipant) {
    throw new SessionAccessDeniedError();
  }

  return {
    sessionId: session.sessionId,
    state: session.state,
    stateVersion: session.stateVersion,
    participants: participants.map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
    })),
  };
}
