import type { SessionRepository } from "./db/sessionRepository";
import type { SubmitQuizResponseResult } from "./types";
import { SessionNotFoundError, SessionAccessDeniedError } from "./types";

/**
 * SUBMIT_QUIZ_RESPONSE command handler.
 *
 * Quiz Experience. Dedicated command, not a generalization of
 * SUBMIT_RESPONSE — unlike that command, which always targets "the
 * session's current interaction instance," this one requires the
 * caller to explicitly name which Quiz question Interaction Instance
 * they are answering, since a Quiz has N simultaneously-active
 * questions and participants progress through them independently.
 *
 * Scope: authenticates the caller as a participant of this session via
 * their participant token (mirrors submitResponse.ts's own
 * fast-path/authoritative-recheck split — this lookup is a fast-path
 * for immediate rejection, not the sole guarantee; the repository's
 * submitQuizResponse call re-verifies the token, the target instance's
 * ownership, and the Quiz window's open/closed state inside the same
 * atomic operation), then upserts the participant's answer to the
 * named question.
 */
export async function submitQuizResponse(
  repo: SessionRepository,
  sessionId: string,
  participantToken: string,
  interactionInstanceId: string,
  selectedOptionIndex: number
): Promise<SubmitQuizResponseResult> {
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

  const result = await repo.submitQuizResponse(
    sessionId,
    participant.participantId,
    participantToken,
    interactionInstanceId,
    selectedOptionIndex
  );

  return {
    submissionId: result.submissionId,
    sessionId,
    interactionInstanceId: result.interactionInstanceId,
    participantId: participant.participantId,
    selectedOptionIndex,
    updatedAt: result.updatedAt,
  };
}
