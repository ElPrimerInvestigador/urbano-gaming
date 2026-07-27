import type { SessionRepository } from "./db/sessionRepository";
import type { StartSessionResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  PreviousInteractionNotRevealedError,
  EmptyPromptTextError,
  PromptTextTooLongError,
} from "./types";

const MAX_PROMPT_TEXT_LENGTH = 1000;

/**
 * Validates and trims host-supplied prompt text per the MVP prompt
 * floor: at least one visible character after trimming, at most
 * MAX_PROMPT_TEXT_LENGTH characters after trimming. Mirrors
 * submitResponse.ts's validateAndTrimResponse exactly — same floor,
 * same reasoning, applied to the host's input instead of the
 * participant's.
 */
function validateAndTrimPromptText(text: string): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new EmptyPromptTextError();
  }

  if (trimmed.length > MAX_PROMPT_TEXT_LENGTH) {
    throw new PromptTextTooLongError();
  }

  return trimmed;
}

/**
 * START_SESSION command handler.
 *
 * Slice 001 (Session / Interaction separation): re-invocable — callable
 * once per interaction rather than once per session's entire
 * lifetime — and now requires host-supplied prompt text on every
 * call, superseding the fixed single seeded prompt.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is LOBBY_LOCKED and that the
 * session's current interaction instance (if any) is already
 * RESULT_REVEAL, and atomically creates a new interaction instance —
 * with a freshly created prompt — in PROMPT_ACTIVE, persisting an
 * INTERACTION_STARTED event. The session's own state and
 * state_version are never touched by this call. Nothing else — no
 * SESSION_INTRO (excluded from the MVP until it has defined product
 * meaning), no generalized engine selection, no modifiers.
 *
 * Host-token, session-state, and previous-interaction authority: the
 * getSessionById / getInteractionInstancesForSession lookups below
 * are a fast-path check for immediate rejection — they are NOT the
 * sole guarantee, the same way every other command's lookup isn't.
 * The repository's startSession call is the authoritative check,
 * re-verifying the host token, the session state, and the previous
 * interaction instance's state — and creating the prompt and
 * interaction instance — inside the same atomic operation.
 */
export async function startSession(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  promptText: string
): Promise<StartSessionResult> {
  const trimmedPromptText = validateAndTrimPromptText(promptText);

  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (session.state !== "LOBBY_LOCKED") {
    throw new LobbyNotLockedError(session.state);
  }

  const interactionInstances = await repo.getInteractionInstancesForSession(
    sessionId
  );
  const previousInteraction =
    interactionInstances.length > 0
      ? interactionInstances[interactionInstances.length - 1]
      : null;

  if (previousInteraction && previousInteraction.state !== "RESULT_REVEAL") {
    throw new PreviousInteractionNotRevealedError(previousInteraction.state);
  }

  const result = await repo.startSession(
    session.sessionId,
    hostToken,
    trimmedPromptText
  );

  return {
    sessionId: session.sessionId,
    interactionInstanceId: result.interactionInstanceId,
    promptId: result.promptId,
    state: result.state,
  };
}
