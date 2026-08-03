import type { SessionRepository } from "./db/sessionRepository";
import type { PrepareQuestionsInput, PrepareQuestionsResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
  EmptyPromptTextError,
  PromptTextTooLongError,
  InvalidOptionsError,
  InvalidCorrectOptionIndexError,
  InvalidPointsError,
} from "./types";

const MAX_PROMPT_TEXT_LENGTH = 1000;
const MAX_POINTS = 10000;
const DEFAULT_POINTS_FOR_CORRECT = 10;

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

function validateAndTrimOptions(options: string[]): string[] {
  const trimmed = options.map((option) => option.trim());

  if (trimmed.length < 2 || trimmed.some((option) => option.length === 0)) {
    throw new InvalidOptionsError();
  }

  const distinct = new Set(trimmed);
  if (distinct.size !== trimmed.length) {
    throw new InvalidOptionsError();
  }

  return trimmed;
}

function validateCorrectOptionIndex(
  correctOptionIndex: number,
  optionCount: number
): void {
  if (
    !Number.isInteger(correctOptionIndex) ||
    correctOptionIndex < 0 ||
    correctOptionIndex >= optionCount
  ) {
    throw new InvalidCorrectOptionIndexError();
  }
}

function resolvePoints(points: number | undefined): number {
  if (points === undefined) {
    return DEFAULT_POINTS_FOR_CORRECT;
  }

  if (!Number.isInteger(points) || points <= 0 || points > MAX_POINTS) {
    throw new InvalidPointsError();
  }

  return points;
}

/**
 * PREPARE_QUESTIONS command handler.
 *
 * Slice 003 (Second Interaction Engine). Lets the host author a batch
 * of Multiple Choice questions before (or during) a session, ahead of
 * running through them one at a time via START_SESSION's explicit
 * preparedQuestionId. Independent of Interaction Instance entirely —
 * nothing here creates a prompt, an interaction instance, or any
 * per-question runtime state; that only happens when a question is
 * actually started.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is not SESSION_COMPLETE (there is
 * no reason to author further questions for a session that has
 * ended — but unlike most other commands here, no specific *positive*
 * state is required; a host may prepare questions at any point before
 * completion, including before the lobby locks), validates every
 * question in the batch, and persists them all as new prepared_questions
 * rows. Every question is validated before any is persisted — a
 * partially invalid batch is rejected in full, not partially inserted.
 *
 * Unlike every other write command in this codebase, this one has no
 * atomic-function counterpart: authoring a prepared question protects
 * no concurrent invariant (no state transition is being raced), only
 * an ordinal assignment scoped to a single host's own UI — see
 * SessionRepository.createPreparedQuestions's doc comment.
 */
export async function prepareQuestions(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  questions: PrepareQuestionsInput[]
): Promise<PrepareQuestionsResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (session.state === "SESSION_COMPLETE") {
    throw new SessionAlreadyCompleteError();
  }

  const validated = questions.map((question) => {
    const promptText = validateAndTrimPromptText(question.promptText);
    const options = validateAndTrimOptions(question.options);
    validateCorrectOptionIndex(question.correctOptionIndex, options.length);
    const pointsForCorrect = resolvePoints(question.points);

    return {
      promptText,
      options,
      correctOptionIndex: question.correctOptionIndex,
      pointsForCorrect,
    };
  });

  const created = await repo.createPreparedQuestions(sessionId, validated);

  return {
    sessionId,
    questions: created.map((question) => ({
      preparedQuestionId: question.preparedQuestionId,
      ordinal: question.ordinal,
      promptText: question.promptText,
      options: question.options,
      correctOptionIndex: question.correctOptionIndex,
      pointsForCorrect: question.pointsForCorrect,
      consumedAt: question.consumedAt,
    })),
  };
}
