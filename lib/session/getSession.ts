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

  // Slice 003 (Second Interaction Engine): resolved once, up front,
  // since both currentPrompt's shape and submissions' visibility now
  // depend on which engine produced the current interaction.
  const multipleChoiceDetails =
    currentInteraction && currentInteraction.engineType === "MULTIPLE_CHOICE"
      ? await repo.getMultipleChoiceDetailsForInteraction(
          currentInteraction.interactionInstanceId
        )
      : null;
  const isRevealed = currentInteraction?.state === "RESULT_REVEAL";

  // Visible regardless of session state once an interaction has ever
  // started — mirrors the pre-Slice-001 precedent where currentPrompt
  // stayed visible after SESSION_COMPLETE. Slice 003: options is
  // populated whenever this is a Multiple Choice interaction (needed
  // to answer at all); correctOptionIndex is this platform's first
  // genuinely private-until-reveal field — known internally from
  // creation, but withheld from every caller, host included, until the
  // interaction reaches RESULT_REVEAL, mirroring submissions' existing
  // reveal-gating below.
  const currentPromptRecord = currentInteraction
    ? await repo.getPromptById(currentInteraction.promptId)
    : null;
  const currentPrompt = currentPromptRecord
    ? {
        promptId: currentPromptRecord.promptId,
        text: currentPromptRecord.text,
        options: multipleChoiceDetails?.options ?? null,
        correctOptionIndex:
          multipleChoiceDetails && isRevealed
            ? multipleChoiceDetails.correctOptionIndex
            : null,
      }
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
    // Slice 003: for a Multiple Choice interaction, the stored text is
    // the selected option's index, not something a host or participant
    // should ever see raw — resolved here to the option's actual
    // label, with correctness computed alongside it. Open Response
    // keeps its raw free-text display and isCorrect stays null, since
    // it has no correctness concept at all.
    submissions = allSubmissions.map((s) => {
      if (multipleChoiceDetails) {
        const selectedIndex = Number(s.text);
        const label =
          multipleChoiceDetails.options[selectedIndex] ?? s.text;
        return {
          participantId: s.participantId,
          displayName: displayNameByParticipantId.get(s.participantId) ?? "",
          text: label,
          isCorrect: selectedIndex === multipleChoiceDetails.correctOptionIndex,
        };
      }

      return {
        participantId: s.participantId,
        displayName: displayNameByParticipantId.get(s.participantId) ?? "",
        text: s.text,
        isCorrect: null,
      };
    });
  }

  // Slice 002 (Scored Multi-Round Experience): standings are always
  // computed, with their own visibility rule independent of the
  // currentPrompt/submissions branches above — they must remain
  // visible at SESSION_COMPLETE (final standings), unlike submissions,
  // which intentionally goes null again at that point. Every
  // participant appears, defaulting to a score of 0, so the client
  // never has to distinguish "no standings yet" from "no awards yet."
  const pointAwards = await repo.getPointAwardsForSession(sessionId);
  const scoreByParticipantId = new Map<string, number>();
  for (const award of pointAwards) {
    scoreByParticipantId.set(
      award.participantId,
      (scoreByParticipantId.get(award.participantId) ?? 0) + award.points
    );
  }
  const standings = participants.map((participant) => ({
    participantId: participant.participantId,
    displayName: participant.displayName,
    score: scoreByParticipantId.get(participant.participantId) ?? 0,
  }));

  // Slice 003: the first field in this platform's history that
  // differs by caller role rather than only by overall access. Every
  // prepared question's correctOptionIndex is authoring-time data the
  // host must be able to review — and must never reach a participant,
  // who is equally authorized to call GET_SESSION at all, just not to
  // see this.
  const preparedQuestions = isHost
    ? (await repo.getPreparedQuestionsForSession(sessionId)).map((q) => ({
        preparedQuestionId: q.preparedQuestionId,
        ordinal: q.ordinal,
        promptText: q.promptText,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        pointsForCorrect: q.pointsForCorrect,
        consumedAt: q.consumedAt,
      }))
    : null;

  // Session Continuity slice: a successor can only exist once this
  // session is SESSION_COMPLETE (CREATE_SUCCESSOR_SESSION requires it),
  // so the lookup is skipped for every other state rather than adding
  // a query to the hot, frequently-polled path for sessions still in
  // progress. Visible to host and participant alike — see
  // GetSessionResult's doc comment for why this needs no role gating.
  let successorSessionId: string | null = null;
  let successorRoomCode: string | null = null;
  if (session.state === "SESSION_COMPLETE") {
    const successor = await repo.getSuccessorSessionByPredecessorId(sessionId);
    if (successor) {
      successorSessionId = successor.sessionId;
      successorRoomCode = successor.roomCode;
    }
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
    currentInteractionInstanceId: currentInteraction?.interactionInstanceId ?? null,
    currentEngineType: currentInteraction?.engineType ?? null,
    currentPrompt,
    submittedCount,
    eligibleParticipantCount,
    submissions,
    standings,
    preparedQuestions,
    successorSessionId,
    successorRoomCode,
  };
}
