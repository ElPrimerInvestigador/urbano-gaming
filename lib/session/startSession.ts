import type { SessionRepository } from "./db/sessionRepository";
import type {
  StartSessionResult,
  VotingCandidateSource,
  SegmentTarget,
} from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  PreviousInteractionNotRevealedError,
  NoCurrentSegmentToContinueError,
  EmptyPromptTextError,
  PromptTextTooLongError,
  InvalidVotingCandidatesError,
  AmbiguousStartSessionTargetError,
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
 *
 * Slice 003 (Second Interaction Engine): an optional preparedQuestionId
 * starts a specific, previously-authored Multiple Choice question
 * instead of an Open Response interaction. When supplied, promptText
 * is not validated or used at all — the prompt text for a Multiple
 * Choice interaction comes from the prepared question itself, resolved
 * authoritatively by the repository. Deliberately explicit rather than
 * an implicit "use the next unconsumed prepared question" fallback:
 * the caller always names the exact question being started, so this
 * command's meaning never depends on hidden repository state. A host
 * UI may still present one "Start next question" button that
 * auto-selects the lowest unconsumed ordinal from GET_SESSION's
 * preparedQuestions field — but the request it sends here always
 * carries that specific id.
 *
 * Slice 007 (Voting Engine): an optional votingCandidateSource starts a
 * VOTING interaction instead, mutually exclusive with
 * preparedQuestionId — supplying both explicitly throws
 * AmbiguousStartSessionTargetError rather than silently letting one
 * win, since silent precedence would mask a likely client bug. The
 * repository's atomic function re-enforces this same rejection
 * authoritatively. Unlike the prepared-question path,
 * promptText IS still required here — Voting always needs host-framed
 * text, since neither Candidate source supplies one. A HOST_AUTHORED
 * source's candidate list gets the same fast-path validation
 * prepareQuestions.ts's validateAndTrimOptions already applies to
 * Multiple Choice options (at least two distinct, non-empty entries);
 * a SUBMISSION source's eligibility (belongs to this session, is
 * OPEN_RESPONSE, is RESULT_REVEAL, has submissions) is deep enough that
 * only the atomic function can authoritatively check it.
 *
 * Slice 008 (Segment / Turn grouping): an optional segmentTarget,
 * defaulting to "NEW_SEGMENT" when omitted — every pre-Slice-008 caller
 * keeps working unchanged. "CURRENT_SEGMENT" is the mechanism behind
 * the Best Joke proving case: attaching a new Interaction Instance (e.g.
 * Voting) to the same Turn an earlier one (e.g. Open Response) already
 * ran in, rather than starting a new Turn. The fast-path
 * NoCurrentSegmentToContinueError check below mirrors this function's
 * existing previousInteraction fast-path exactly — an immediate,
 * cheap rejection ahead of the repository's own authoritative re-check.
 */
export async function startSession(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  promptText: string,
  preparedQuestionId?: string | null,
  votingCandidateSource?: VotingCandidateSource | null,
  segmentTarget: SegmentTarget = "NEW_SEGMENT"
): Promise<StartSessionResult> {
  if (preparedQuestionId && votingCandidateSource) {
    throw new AmbiguousStartSessionTargetError();
  }

  const trimmedPromptText = preparedQuestionId
    ? ""
    : validateAndTrimPromptText(promptText);

  let normalizedVotingCandidateSource: VotingCandidateSource | undefined;
  if (votingCandidateSource) {
    if (votingCandidateSource.type === "HOST_AUTHORED") {
      const trimmed = votingCandidateSource.candidates.map((c) => c.trim());
      const distinct = new Set(trimmed);
      if (
        trimmed.length < 2 ||
        trimmed.some((c) => c.length === 0) ||
        distinct.size !== trimmed.length
      ) {
        throw new InvalidVotingCandidatesError();
      }
      normalizedVotingCandidateSource = {
        type: "HOST_AUTHORED",
        candidates: trimmed,
      };
    } else {
      normalizedVotingCandidateSource = votingCandidateSource;
    }
  }

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

  if (segmentTarget === "CURRENT_SEGMENT" && !previousInteraction) {
    throw new NoCurrentSegmentToContinueError();
  }

  const result = await repo.startSession(
    session.sessionId,
    hostToken,
    trimmedPromptText,
    preparedQuestionId,
    normalizedVotingCandidateSource,
    segmentTarget
  );

  return {
    sessionId: session.sessionId,
    interactionInstanceId: result.interactionInstanceId,
    promptId: result.promptId,
    state: result.state,
    engineType: result.engineType,
    segmentNumber: result.segmentNumber,
  };
}
