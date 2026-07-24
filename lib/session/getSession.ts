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

  const currentPrompt = session.currentPromptId
    ? await repo.getPromptById(session.currentPromptId)
    : null;

  let submittedCount: number | null = null;
  let eligibleParticipantCount: number | null = null;
  let submissions: GetSessionResult["submissions"] = null;

  if (session.state === "PROMPT_ACTIVE" || session.state === "SUBMISSIONS_CLOSED") {
    const allSubmissions = await repo.getSubmissionsForSession(sessionId);
    const relevantSubmissions = session.currentPromptId
      ? allSubmissions.filter((s) => s.promptId === session.currentPromptId)
      : [];
    submittedCount = relevantSubmissions.length;
    eligibleParticipantCount = participants.length;
  } else if (session.state === "RESULT_REVEAL") {
    // Deliberately not extended to SESSION_COMPLETE the way currentPrompt
    // is: whether a completed session ever actually passed through
    // RESULT_REVEAL (vs. an early admin termination) isn't cheaply
    // knowable from SessionRecord alone, and showing responses the host
    // never explicitly revealed would be the wrong default to guess.
    const allSubmissions = await repo.getSubmissionsForSession(sessionId);
    const relevantSubmissions = session.currentPromptId
      ? allSubmissions.filter((s) => s.promptId === session.currentPromptId)
      : [];
    const displayNameByParticipantId = new Map(
      participants.map((p) => [p.participantId, p.displayName])
    );
    submissions = relevantSubmissions.map((s) => ({
      participantId: s.participantId,
      displayName: displayNameByParticipantId.get(s.participantId) ?? "",
      text: s.text,
    }));
  }

  return {
    sessionId: session.sessionId,
    state: session.state,
    stateVersion: session.stateVersion,
    participants: participants.map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
    })),
    currentPrompt: currentPrompt
      ? { promptId: currentPrompt.promptId, text: currentPrompt.text }
      : null,
    submittedCount,
    eligibleParticipantCount,
    submissions,
  };
}
