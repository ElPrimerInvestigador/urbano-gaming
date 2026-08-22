import type { SessionRepository } from "./db/sessionRepository";
import type { SetSessionCapabilitiesResult } from "./types";
import { SessionNotFoundError, HostTokenMismatchError } from "./types";

/**
 * SET_SESSION_CAPABILITIES command handler.
 *
 * Session Capability Architecture v1 (Product/Session_Capability_Architecture.md,
 * ADR-036). Scope: authenticates the caller as the session's host via
 * the stored host token, then delegates key validation, normalization
 * (dedupe + canonical sort), and the evidence-derived lock check
 * entirely to the repository's atomic operation — mirroring
 * lockLobby.ts's exact discipline. Unlike lockLobby, there is no
 * simple state precondition to fast-path here (the real question,
 * "has a real participant ever joined," requires the same evidence
 * query the atomic operation must already perform authoritatively),
 * so this handler fast-paths only what getSessionById already gives
 * for free — SessionNotFoundError and HostTokenMismatchError — and
 * leaves everything else to the repository.
 *
 * Callable any number of times before this session's first real
 * participant join. Idempotent on an unchanged (order-independent)
 * set once locked; rejects any changed set with CapabilitiesLockedError.
 */
export async function setSessionCapabilities(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  capabilities: string[]
): Promise<SetSessionCapabilitiesResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  const result = await repo.setSessionCapabilities(
    session.sessionId,
    hostToken,
    capabilities
  );

  return {
    sessionId: session.sessionId,
    declaredCapabilities: result.declaredCapabilities,
    locked: result.locked,
  };
}
