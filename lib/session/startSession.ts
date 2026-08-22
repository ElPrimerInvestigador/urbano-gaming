import type { SessionRepository } from "./db/sessionRepository";
import type {
  StartSessionResult,
  StartTurnConfig,
  SegmentTarget,
  SessionCapabilityKey,
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
  CapabilityNotAuthorizedError,
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
 * state_version are never touched by this call.
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
 * Slice 009 (Engine Selection + PARTICIPANTS Voting): `config`
 * (StartTurnConfig) replaces the previous shape of independent optional
 * fields (promptText / preparedQuestionId / votingCandidateSource).
 * Because it is a real discriminated union, "both a preparedQuestionId
 * and a candidateSource" is now structurally unreachable through this
 * function — AmbiguousStartSessionTargetError is no longer checked
 * here (it remains reachable only where untyped input still exists:
 * the API route's legacy flat-shape compatibility shim, and the SQL
 * RPC's own defense-in-depth re-check).
 *
 * - OPEN_RESPONSE: promptText validated/trimmed exactly as before.
 * - MULTIPLE_CHOICE: preparedQuestionId passed through untouched — the
 *   prompt text for a Multiple Choice interaction comes from the
 *   prepared question itself, resolved authoritatively by the
 *   repository. Deliberately explicit rather than an implicit "use the
 *   next unconsumed prepared question" fallback.
 * - VOTING: promptText validated/trimmed (Voting always needs
 *   host-framed text, since no Candidate source supplies one).
 *   candidateSource "HOST_AUTHORED" gets the same fast-path validation
 *   prepareQuestions.ts's validateAndTrimOptions already applies to
 *   Multiple Choice options (at least two distinct, non-empty entries).
 *   "SUBMISSION" eligibility is deep enough that only the repository's
 *   atomic operation can authoritatively check it. "PARTICIPANTS" gets
 *   its own fast-path floor check below — mirrors HOST_AUTHORED's own
 *   ≥2-candidate floor, since a Voting round is equally unusable with
 *   fewer than two Candidates regardless of source.
 *
 * `segmentTarget`, defaulting to "NEW_SEGMENT" when omitted (every
 * pre-Slice-008 caller keeps working unchanged), remains a separate,
 * orthogonal parameter — not part of StartTurnConfig. "CURRENT_SEGMENT"
 * is the mechanism behind the Best Joke proving case: attaching a new
 * Interaction Instance (e.g. Voting) to the same Turn an earlier one
 * (e.g. Open Response) already ran in, rather than starting a new Turn.
 * The fast-path NoCurrentSegmentToContinueError check below mirrors
 * this function's existing previousInteraction fast-path exactly.
 */
export async function startSession(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  config: StartTurnConfig,
  segmentTarget: SegmentTarget = "NEW_SEGMENT"
): Promise<StartSessionResult> {
  let normalizedConfig: StartTurnConfig;

  if (config.engineType === "OPEN_RESPONSE") {
    normalizedConfig = {
      engineType: "OPEN_RESPONSE",
      promptText: validateAndTrimPromptText(config.promptText),
    };
  } else if (config.engineType === "MULTIPLE_CHOICE") {
    normalizedConfig = config;
  } else {
    const trimmedPromptText = validateAndTrimPromptText(config.promptText);
    const source = config.candidateSource;

    if (source.type === "HOST_AUTHORED") {
      const trimmed = source.candidates.map((c) => c.trim());
      const distinct = new Set(trimmed);
      if (
        trimmed.length < 2 ||
        trimmed.some((c) => c.length === 0) ||
        distinct.size !== trimmed.length
      ) {
        throw new InvalidVotingCandidatesError();
      }
      normalizedConfig = {
        engineType: "VOTING",
        promptText: trimmedPromptText,
        candidateSource: { type: "HOST_AUTHORED", candidates: trimmed },
      };
    } else {
      normalizedConfig = {
        engineType: "VOTING",
        promptText: trimmedPromptText,
        candidateSource: source,
      };
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

  // Session Capability Architecture v1: fast-path convenience mirroring
  // every other precondition here — the repository's startSession call
  // is the authoritative re-check (see 0111's identical guard).
  const requiredCapability: SessionCapabilityKey =
    normalizedConfig.engineType === "MULTIPLE_CHOICE"
      ? "TRIVIA"
      : normalizedConfig.engineType === "VOTING"
      ? "VOTING"
      : "OPEN_RESPONSE";
  if (!(session.declaredCapabilities ?? []).includes(requiredCapability)) {
    throw new CapabilityNotAuthorizedError(requiredCapability);
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

  // Slice 009: PARTICIPANTS fast-path floor check — the same
  // immediate, cheap rejection ahead of the repository's own
  // authoritative re-check that every other precondition here follows.
  if (
    normalizedConfig.engineType === "VOTING" &&
    normalizedConfig.candidateSource.type === "PARTICIPANTS"
  ) {
    const participants = await repo.getParticipantsForSession(sessionId);
    if (participants.length < 2) {
      throw new InvalidVotingCandidatesError();
    }
  }

  const result = await repo.startSession(
    session.sessionId,
    hostToken,
    normalizedConfig,
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
