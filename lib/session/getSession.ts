import type { SessionRepository } from "./db/sessionRepository";
import type { GetSessionResult } from "./types";
import { SessionNotFoundError, SessionAccessDeniedError } from "./types";

/**
 * GET_SESSION command handler.
 *
 * Scope: returns current session state, state_version, the
 * participant list (display names only — never a hostToken or any
 * participantToken), and Slice 001 (Session / Interaction
 * separation): the current interaction instance's number, state, and
 * prompt. Read-only, no state mutation, no event write.
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

  const interactionInstances = await repo.getInteractionInstancesForSession(
    sessionId
  );
  const currentInteraction =
    interactionInstances.length > 0
      ? interactionInstances[interactionInstances.length - 1]
      : null;
  const interactionNumber =
    interactionInstances.length > 0 ? interactionInstances.length : null;

  // Visible regardless of session state once an interaction has ever
  // started — mirrors the pre-Slice-001 precedent where currentPrompt
  // stayed visible after SESSION_COMPLETE.
  const currentPrompt = currentInteraction
    ? await repo.getPromptById(currentInteraction.promptId)
    : null;

  let submittedCount: number | null = null;
  let eligibleParticipantCount: number | null = null;
  let submissions: GetSessionResult["submissions"] = null;

  // Both branches below require session.state === "LOBBY_LOCKED" —
  // this exactly preserves the pre-Slice-001 behavior of resetting to
  // null once the session reaches SESSION_COMPLETE, now expressed via
  // two conditions (session state + interaction state) instead of one,
  // since those two responsibilities are no longer the same field.
  if (
    session.state === "LOBBY_LOCKED" &&
    currentInteraction &&
    (currentInteraction.state === "PROMPT_ACTIVE" ||
      currentInteraction.state === "SUBMISSIONS_CLOSED")
  ) {
    const allSubmissions = await repo.getSubmissionsForInteractionInstance(
      currentInteraction.interactionInstanceId
    );
    submittedCount = allSubmissions.length;
    eligibleParticipantCount = participants.length;
  } else if (
    session.state === "LOBBY_LOCKED" &&
    currentInteraction &&
    currentInteraction.state === "RESULT_REVEAL"
  ) {
    // Deliberately not extended to SESSION_COMPLETE, mirroring the
    // pre-Slice-001 reasoning exactly: whether a completed session's
    // current interaction ever actually passed through RESULT_REVEAL
    // (vs. an early admin termination) is, in principle, now cheaply
    // knowable from the interaction instance's own persisted state —
    // but changing this visibility behavior is not part of this
    // slice's scope, so the same reset-to-null-at-completion behavior
    // already relied upon by the harness's lastKnownSubmissions cache
    // is preserved unchanged.
    const allSubmissions = await repo.getSubmissionsForInteractionInstance(
      currentInteraction.interactionInstanceId
    );
    const displayNameByParticipantId = new Map(
      participants.map((p) => [p.participantId, p.displayName])
    );
    submissions = allSubmissions.map((s) => ({
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
    interactionNumber,
    interactionState: currentInteraction?.state ?? null,
    currentPrompt: currentPrompt
      ? { promptId: currentPrompt.promptId, text: currentPrompt.text }
      : null,
    submittedCount,
    eligibleParticipantCount,
    submissions,
  };
}
