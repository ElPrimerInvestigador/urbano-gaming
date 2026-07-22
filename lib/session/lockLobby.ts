import type { SessionRepository, LobbyLockedEventRecord } from "./db/sessionRepository";
import type { LockLobbyResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotOpenError,
} from "./types";

/**
 * LOCK_LOBBY command handler.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is LOBBY_OPEN, and atomically
 * transitions it to LOBBY_LOCKED, incrementing state_version and
 * persisting a LOBBY_LOCKED event. Nothing else — no participant
 * notification, no readiness checks, no further state transitions.
 *
 * Host-token and session-state authority: the getSessionById lookup
 * below is a fast-path check for immediate rejection (nonexistent
 * session, wrong host token, obviously-already-locked lobby) — it is
 * NOT the sole guarantee, the same way JOIN_SESSION's room-code lookup
 * isn't. The repository's lockLobby call is the authoritative check,
 * re-verifying both the host token and the session state inside the
 * same atomic operation that performs the transition, to close the
 * race window between this lookup and that write.
 */
export async function lockLobby(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string
): Promise<LockLobbyResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (session.state !== "LOBBY_OPEN") {
    throw new LobbyNotOpenError(session.state);
  }

  const event: LobbyLockedEventRecord = {
    sessionId: session.sessionId,
    eventType: "LOBBY_LOCKED",
    payload: {},
  };

  const result = await repo.lockLobby(session.sessionId, hostToken, event);

  return {
    sessionId: session.sessionId,
    state: result.state,
    stateVersion: result.stateVersion,
  };
}
