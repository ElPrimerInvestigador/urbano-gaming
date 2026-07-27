import type { SessionRepository } from "./db/sessionRepository";
import type { SubmitResponseResult } from "./types";
import {
  SessionNotFoundError,
  SessionAccessDeniedError,
  PromptNotActiveError,
  EmptyResponseError,
  ResponseTooLongError,
} from "./types";

const MAX_RESPONSE_LENGTH = 1000;

/**
 * Validates and trims a submitted response per the MVP response floor:
 * at least one visible character after trimming, at most
 * MAX_RESPONSE_LENGTH characters after trimming. A deliberately
 * generous, adjustable placeholder — not a considered product limit.
 */
function validateAndTrimResponse(text: string): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new EmptyResponseError();
  }

  if (trimmed.length > MAX_RESPONSE_LENGTH) {
    throw new ResponseTooLongError();
  }

  return trimmed;
}

/**
 * SUBMIT_RESPONSE command handler.
 *
 * Scope: authenticates the caller as a participant of this session via
 * their participant token (never a host token — see below), verifies
 * the session is LOBBY_LOCKED and its current interaction instance is
 * PROMPT_ACTIVE (Slice 001: this used to be "the session is
 * PROMPT_ACTIVE" directly — that responsibility now belongs to the
 * interaction instance), and atomically upserts the participant's
 * response to that interaction instance, persisting a
 * RESPONSE_SUBMITTED event. Nothing else.
 *
 * "Last write wins" (a second submission from the same participant
 * replaces the first) is an explicit MVP implementation decision, not
 * a permanent gameplay rule — future product validation may determine
 * immutable submissions or a different revision policy.
 *
 * Authentication: unlike GET_SESSION, which accepts either the host
 * token or a participant token, this command is participant-only.
 * A host token does not authenticate here unless the host is also a
 * joined participant of this session — there is no host fallback.
 *
 * Participant-token, session-state, and interaction-state authority:
 * the getParticipantsForSession / getInteractionInstancesForSession
 * lookups below are a fast-path check for immediate rejection
 * (nonexistent session, unrecognized token, obviously-not-active
 * interaction) — they are NOT the sole guarantee, the same way every
 * other command's fast-path lookup isn't. The repository's
 * submitResponse call is the authoritative check, re-verifying the
 * participant token, the session state, and the current interaction
 * instance's state inside the same atomic operation that performs the
 * upsert.
 */
export async function submitResponse(
  repo: SessionRepository,
  sessionId: string,
  participantToken: string,
  text: string
): Promise<SubmitResponseResult> {
  const trimmedText = validateAndTrimResponse(text);

  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  const participants = await repo.getParticipantsForSession(sessionId);
  const participant = participants.find(
    (p) => p.participantToken === participantToken
  );

  if (!participant) {
    throw new SessionAccessDeniedError();
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
    currentInteraction.state !== "PROMPT_ACTIVE"
  ) {
    throw new PromptNotActiveError(currentInteraction?.state);
  }

  const result = await repo.submitResponse(
    sessionId,
    participant.participantId,
    participantToken,
    trimmedText
  );

  return {
    submissionId: result.submissionId,
    sessionId,
    interactionInstanceId: result.interactionInstanceId,
    participantId: participant.participantId,
    text: trimmedText,
    updatedAt: result.updatedAt,
  };
}
