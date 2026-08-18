import type { SessionRepository } from "./db/sessionRepository";
import type { CastVoteResult } from "./types";
import {
  SessionNotFoundError,
  SessionAccessDeniedError,
  PromptNotActiveError,
  SelfVoteNotAllowedError,
} from "./types";

/**
 * CAST_VOTE command handler.
 *
 * Slice 007 (Voting Engine). Structurally mirrors submitResponse.ts:
 * authenticates the caller as a participant of this session via their
 * participant token (never a host token — no host fallback, matching
 * SUBMIT_RESPONSE's identical rule, since the host does not vote in
 * this slice), verifies the session is LOBBY_LOCKED and its current
 * interaction instance is PROMPT_ACTIVE and engineType VOTING, and
 * atomically upserts the participant's vote against that interaction
 * instance, persisting a VOTE_CAST event.
 *
 * "Last write wins" (a second cast_vote call from the same participant
 * replaces the first, while the interaction remains PROMPT_ACTIVE) is
 * deliberately the same MVP decision SUBMIT_RESPONSE already makes for
 * submissions — reusing the existing upsert shape here costs nothing
 * extra to implement, unlike rejecting revision outright, which would
 * require additional logic this slice does not need.
 *
 * Participant-token, session-state, and interaction-state authority:
 * the getParticipantsForSession / getInteractionInstancesForSession
 * lookups below are a fast-path check for immediate rejection — they
 * are NOT the sole guarantee. The repository's castVote call is the
 * authoritative check, re-verifying the participant token, session
 * state, current interaction instance's state and engine type, and
 * the candidate's own membership in that interaction instance, inside
 * the same atomic operation that performs the upsert.
 *
 * Slice 009 (Engine Selection + PARTICIPANTS Voting): a self-vote
 * fast-path is added below, mirroring the existing discipline —
 * immediate, cheap rejection ahead of the repository's own
 * authoritative re-check (which uses the same structured
 * participantId attribution, re-read inside its own atomic operation,
 * not trusted from this earlier lookup).
 */
export async function castVote(
  repo: SessionRepository,
  sessionId: string,
  participantToken: string,
  candidateId: string
): Promise<CastVoteResult> {
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
    currentInteraction.state !== "PROMPT_ACTIVE" ||
    currentInteraction.engineType !== "VOTING"
  ) {
    throw new PromptNotActiveError(currentInteraction?.state);
  }

  const candidates = await repo.getVotingCandidatesForInteraction(
    currentInteraction.interactionInstanceId
  );
  const candidate = candidates.find((c) => c.candidateId === candidateId);
  if (
    candidate &&
    candidate.participantId !== null &&
    candidate.participantId === participant.participantId
  ) {
    throw new SelfVoteNotAllowedError();
  }

  const result = await repo.castVote(
    sessionId,
    participant.participantId,
    participantToken,
    candidateId
  );

  return {
    voteId: result.voteId,
    sessionId,
    interactionInstanceId: result.interactionInstanceId,
    participantId: participant.participantId,
    candidateId: result.candidateId,
    updatedAt: result.updatedAt,
  };
}
