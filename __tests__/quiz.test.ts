import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createSession } from "../lib/session/createSession";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { prepareQuestions } from "../lib/session/prepareQuestions";
import { startQuiz } from "../lib/session/startQuiz";
import { submitQuizResponse } from "../lib/session/submitQuizResponse";
import { closeQuiz } from "../lib/session/closeQuiz";
import { getSession } from "../lib/session/getSession";
import { startSession } from "../lib/session/startSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  InvalidQuizDurationError,
  EmptyQuizQuestionSetError,
  PreviousInteractionNotRevealedError,
  SessionAccessDeniedError,
  QuizInstanceNotFoundError,
  QuizClosedError,
  InvalidOptionSelectionError,
  QuizNotFoundError,
  QuizAccessDeniedError,
  QuizExpiryNotReachedError,
} from "../lib/session/types";

/**
 * Quiz Experience (self-paced, independent participant progression —
 * distinct from Trivia, accepted after a dedicated design pass and a
 * three-seam implementation-readiness pressure test). Covers the
 * founder-directed test plan: Start Quiz composition, independent
 * participant progression, submission authority (including the
 * authoritative deadline check), the privacy boundary (no correctness
 * leaked before close), Close Quiz idempotency/concurrency, scoring,
 * and reconnect (progress re-derived, never stored). Trivia/Open
 * Response/Voting regression is covered by the unmodified existing
 * suites re-running unchanged alongside this file — see the
 * implementation record.
 */

const Q1 = { promptText: "Q1?", options: ["A", "B"], correctOptionIndex: 0, points: 10 };
const Q2 = { promptText: "Q2?", options: ["A", "B"], correctOptionIndex: 1, points: 10 };
const Q3 = { promptText: "Q3?", options: ["A", "B", "C"], correctOptionIndex: 2, points: 15 };

async function setupPreparedQuiz(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  const jordan = await joinSession(repo, session.roomCode, "Jordan");
  const sam = await joinSession(repo, session.roomCode, "Sam");
  await lockLobby(repo, session.sessionId, session.hostToken);
  await prepareQuestions(repo, session.sessionId, session.hostToken, [Q1, Q2, Q3]);
  return { session, alex, jordan, sam };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("START_QUIZ", () => {
  it("creates one Segment, N Multiple Choice Interaction Instances, and one quiz_windows row", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);

    const result = await startQuiz(repo, session.sessionId, session.hostToken, 120);

    expect(result.totalQuestions).toBe(3);
    expect(repo._allSegments()).toHaveLength(1);
    const instances = repo._allInteractionInstances();
    expect(instances).toHaveLength(3);
    expect(instances.every((i) => i.engineType === "MULTIPLE_CHOICE")).toBe(true);
    expect(instances.every((i) => i.state === "PROMPT_ACTIVE")).toBe(true);
    expect(new Set(instances.map((i) => i.segmentId)).size).toBe(1);
    expect(repo._allQuizWindows()).toHaveLength(1);
    expect(repo._allQuizWindows()[0].segmentId).toBe(result.segmentId);
  });

  it("consumes every currently-unconsumed prepared question", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);

    await startQuiz(repo, session.sessionId, session.hostToken, 120);

    const questions = await repo.getPreparedQuestionsForSession(session.sessionId);
    expect(questions.every((q) => q.consumedAt !== null)).toBe(true);
  });

  it("computes a valid future closesAt from the supplied duration", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);

    const before = Date.now();
    const result = await startQuiz(repo, session.sessionId, session.hostToken, 120);
    const closesAtMs = new Date(result.closesAt).getTime();

    expect(closesAtMs).toBeGreaterThan(before);
    expect(closesAtMs).toBeLessThanOrEqual(Date.now() + 121_000);
  });

  it("rejects a duration outside the accepted bound", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);

    await expect(
      startQuiz(repo, session.sessionId, session.hostToken, 10)
    ).rejects.toBeInstanceOf(InvalidQuizDurationError);
    await expect(
      startQuiz(repo, session.sessionId, session.hostToken, 9999)
    ).rejects.toBeInstanceOf(InvalidQuizDurationError);
  });

  it("rejects starting with zero unconsumed prepared questions", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await joinSession(repo, session.roomCode, "Alex");
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      startQuiz(repo, session.sessionId, session.hostToken, 120)
    ).rejects.toBeInstanceOf(EmptyQuizQuestionSetError);
  });

  it("rejects starting while another interaction is still active", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Ad-hoc question",
    });

    await expect(
      startQuiz(repo, session.sessionId, session.hostToken, 120)
    ).rejects.toBeInstanceOf(PreviousInteractionNotRevealedError);
  });

  it("concurrent Start Quiz requests: exactly one succeeds, no duplicate Segment/quiz_windows", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);

    const attempts = await Promise.allSettled([
      startQuiz(repo, session.sessionId, session.hostToken, 120),
      startQuiz(repo, session.sessionId, session.hostToken, 120),
    ]);

    const successes = attempts.filter((a) => a.status === "fulfilled");
    // The in-memory double is single-threaded (no interleaving between
    // awaits within one call), so both calls run to completion — the
    // second sees zero unconsumed prepared questions left and fails
    // with EmptyQuizQuestionSetError, the same terminal safety the real
    // database's row-locked FOR UPDATE loop provides under genuine
    // concurrency. Either way, exactly one Quiz is ever created.
    expect(successes).toHaveLength(1);
    expect(repo._allSegments()).toHaveLength(1);
    expect(repo._allQuizWindows()).toHaveLength(1);
  });
});

describe("Independent participant progression", () => {
  it("three participants at completely different progress are all simultaneously valid", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, sam } = await setupPreparedQuiz(repo);
    await startQuiz(repo, session.sessionId, session.hostToken, 120);

    const instances = repo
      ._allInteractionInstances()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const [i1, i2, i3] = instances;

    // Alex: answers all three (3/3).
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, i1.interactionInstanceId, 0);
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, i2.interactionInstanceId, 1);
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, i3.interactionInstanceId, 2);

    // Jordan: answers only the first (1/3) — never reaches Q2/Q3.
    await submitQuizResponse(repo, session.sessionId, jordan.participantToken, i1.interactionInstanceId, 0);

    // Sam: answers none (0/3).

    const hostView = await getSession(repo, session.sessionId, session.hostToken);
    const progress = hostView.currentQuiz?.participantProgress ?? [];
    const byName = Object.fromEntries(progress.map((p) => [p.displayName, p.answered]));

    expect(byName["Alex"]).toBe(3);
    expect(byName["Jordan"]).toBe(1);
    expect(byName["Sam"]).toBe(0);

    // No participant's own progress or submission blocked another's —
    // all three calls above succeeded independently, at whatever
    // "question" each participant chose to target, with no shared
    // room-wide question pointer involved.
    const alexView = await getSession(repo, session.sessionId, alex.participantToken);
    expect(alexView.currentQuiz?.myProgress).toEqual({ answered: 3, total: 3 });
    const jordanView = await getSession(repo, session.sessionId, jordan.participantToken);
    expect(jordanView.currentQuiz?.myProgress).toEqual({ answered: 1, total: 3 });
    const samView = await getSession(repo, session.sessionId, sam.participantToken);
    expect(samView.currentQuiz?.myProgress).toEqual({ answered: 0, total: 3 });
  });
});

describe("SUBMIT_QUIZ_RESPONSE authority", () => {
  async function setupActiveQuiz(repo: InMemorySessionRepository) {
    const { session, alex, jordan, sam } = await setupPreparedQuiz(repo);
    await startQuiz(repo, session.sessionId, session.hostToken, 120);
    const instances = repo
      ._allInteractionInstances()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { session, alex, jordan, sam, instances };
  }

  it("allows a legal submission and answer revision while the Quiz remains open", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, instances } = await setupActiveQuiz(repo);

    const first = await submitQuizResponse(
      repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0
    );
    expect(first.selectedOptionIndex).toBe(0);

    const revised = await submitQuizResponse(
      repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 1
    );
    expect(revised.submissionId).toBe(first.submissionId);
    expect(revised.selectedOptionIndex).toBe(1);
  });

  it("rejects a wrong participant token", async () => {
    const repo = new InMemorySessionRepository();
    const { session, instances } = await setupActiveQuiz(repo);

    await expect(
      submitQuizResponse(repo, session.sessionId, "not-a-real-token", instances[0].interactionInstanceId, 0)
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects an Interaction Instance from another session (participant token doesn't match the other session)", async () => {
    const repo = new InMemorySessionRepository();
    const { alex, instances } = await setupActiveQuiz(repo);
    const otherSession = await createSession(repo);

    await expect(
      submitQuizResponse(
        repo, otherSession.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0
      )
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects targeting a non-Quiz (Trivia) Interaction Instance", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupPreparedQuiz(repo);
    const trivia = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: (
        await repo.getPreparedQuestionsForSession(session.sessionId)
      )[0].preparedQuestionId,
    });

    await expect(
      submitQuizResponse(repo, session.sessionId, alex.participantToken, trivia.interactionInstanceId, 0)
    ).rejects.toBeInstanceOf(QuizInstanceNotFoundError);
  });

  it("rejects an Interaction Instance belonging to a different session's Quiz Segment", async () => {
    const repo = new InMemorySessionRepository();
    const { session: sessionA, alex } = await setupPreparedQuiz(repo);
    await startQuiz(repo, sessionA.sessionId, sessionA.hostToken, 120);

    const { session: sessionB } = await setupPreparedQuiz(repo);
    await startQuiz(repo, sessionB.sessionId, sessionB.hostToken, 120);
    const sessionBInstance = repo
      ._allInteractionInstances()
      .find((i) => i.sessionId === sessionB.sessionId)!;

    // Alex is a real participant of sessionA, so the participant-token
    // check alone would pass — it's the instance-ownership check
    // (targeting sessionA but naming an instance that actually belongs
    // to sessionB) that must catch this, collapsed into the same
    // QuizInstanceNotFoundError family as every other "not a valid
    // Quiz question for this session" case (see
    // submit_quiz_response_atomically's own comment on this).
    await expect(
      submitQuizResponse(
        repo, sessionA.sessionId, alex.participantToken, sessionBInstance.interactionInstanceId, 0
      )
    ).rejects.toBeInstanceOf(QuizInstanceNotFoundError);
  });

  it("rejects an invalid option index", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, instances } = await setupActiveQuiz(repo);

    await expect(
      submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 99)
    ).rejects.toBeInstanceOf(InvalidOptionSelectionError);
    await expect(
      submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, -1)
    ).rejects.toBeInstanceOf(InvalidOptionSelectionError);
  });

  it("rejects a submission after manual close", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, instances } = await setupActiveQuiz(repo);
    const window = repo._allQuizWindows()[0];

    await closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken);

    await expect(
      submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0)
    ).rejects.toBeInstanceOf(QuizClosedError);
  });

  it("rejects a submission after the deadline has passed, even though closeQuiz was never called", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, instances } = await setupActiveQuiz(repo);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 121_000); // durationSeconds was 120

    // The authoritative rejection is time-based, not derived from the
    // Interaction Instance's own PROMPT_ACTIVE state (still true here —
    // nothing has transitioned it, since CLOSE_QUIZ never ran) — see
    // submit_quiz_response_atomically's own comment for why this
    // distinction is load-bearing.
    await expect(
      submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0)
    ).rejects.toBeInstanceOf(QuizClosedError);
  });
});

describe("Privacy — no leakage before close", () => {
  it("withholds correctOptionIndex, correctness, and other participants' answers while the Quiz is open", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, instances } = await setupPreparedQuiz(repo).then(async (r) => {
      await startQuiz(repo, r.session.sessionId, r.session.hostToken, 120);
      return {
        ...r,
        instances: repo._allInteractionInstances().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    });

    await submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0);
    await submitQuizResponse(repo, session.sessionId, jordan.participantToken, instances[0].interactionInstanceId, 1);

    const alexView = await getSession(repo, session.sessionId, alex.participantToken);
    const quiz = alexView.currentQuiz!;

    expect(quiz.closed).toBe(false);
    for (const q of quiz.questions ?? []) {
      expect(q.correctOptionIndex).toBeNull();
      expect(q.isCorrect).toBeNull();
    }

    // No cross-participant leakage anywhere in the serialized response
    // — Jordan's own answer choice must not be reachable from Alex's
    // GET_SESSION call at all, not even indirectly.
    const serialized = JSON.stringify(alexView);
    expect(alexView.standings.find((s) => s.participantId === jordan.participantId)?.score).toBe(0);
    expect(serialized).not.toMatch(/"selectedOptionIndex":1/);
  });

  it("reveals correctOptionIndex and isCorrect only after close", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, instances } = await setupPreparedQuiz(repo).then(async (r) => {
      await startQuiz(repo, r.session.sessionId, r.session.hostToken, 120);
      return {
        ...r,
        instances: repo._allInteractionInstances().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    });

    await submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0);
    const window = repo._allQuizWindows()[0];
    await closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken);

    const alexView = await getSession(repo, session.sessionId, alex.participantToken);
    const quiz = alexView.currentQuiz!;
    expect(quiz.closed).toBe(true);
    const q1 = quiz.questions!.find((q) => q.interactionInstanceId === instances[0].interactionInstanceId)!;
    expect(q1.correctOptionIndex).toBe(0);
    expect(q1.isCorrect).toBe(true);
  });

  it("host never receives participant answer content, only counts", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, instances } = await setupPreparedQuiz(repo).then(async (r) => {
      await startQuiz(repo, r.session.sessionId, r.session.hostToken, 120);
      return {
        ...r,
        instances: repo._allInteractionInstances().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    });
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0);

    const hostView = await getSession(repo, session.sessionId, session.hostToken);
    expect(hostView.currentQuiz?.questions).toBeNull();
    expect(hostView.currentQuiz?.myProgress).toBeNull();
    const serialized = JSON.stringify(hostView.currentQuiz?.participantProgress);
    expect(serialized).not.toContain("selectedOptionIndex");
  });
});

describe("Privacy — cross-participant answer isolation (legacy `submissions` field regression)", () => {
  // Regression coverage for a real defect found during browser
  // simulation: once a Quiz closed, GET_SESSION's pre-existing,
  // non-Quiz-specific `submissions` field — populated for any caller
  // whenever the current Interaction Instance reaches RESULT_REVEAL,
  // a rule written for Trivia/Open Response/Voting long before Quiz
  // existed — remained populated with the Quiz's last question's raw
  // per-participant answers, since Close Quiz transitions every Quiz
  // Interaction Instance (including the last-created one, which is
  // `currentInteraction`) to RESULT_REVEAL together. This was first
  // caught only by visually inspecting a live screenshot of a third
  // participant's Final Results view (it was invisible to the existing
  // automated privacy tests above, which only ever exercised the new,
  // already-correctly-gated `currentQuiz` field) and was fixed at the
  // read-model layer itself in getSession.ts — `submissions` is now
  // unconditionally suppressed whenever the current interaction
  // belongs to a Quiz Segment. This test targets that exact boundary
  // directly (the raw `GetSessionResult.submissions` field), not the
  // already-covered `currentQuiz.questions` field, and covers both
  // participant-to-participant directions plus the host.
  it("Participant A never receives Participant B's raw answer, and vice versa, via the legacy submissions field — before or after close", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, instances } = await setupPreparedQuiz(repo).then(async (r) => {
      await startQuiz(repo, r.session.sessionId, r.session.hostToken, 120);
      return {
        ...r,
        instances: repo._allInteractionInstances().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    });

    // Alex answers the LAST question (the one currentInteraction/
    // submissions would key off of) with option 0; Jordan answers the
    // same question with option 1 — deliberately different answers, so
    // any leak of one into the other's response is unambiguous.
    const lastInstance = instances[instances.length - 1];
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, lastInstance.interactionInstanceId, 0);
    await submitQuizResponse(repo, session.sessionId, jordan.participantToken, lastInstance.interactionInstanceId, 1);

    // BEFORE close: the last instance is still PROMPT_ACTIVE, so the
    // legacy RESULT_REVEAL-gated `submissions` branch cannot yet fire —
    // asserted directly, not assumed.
    const alexBeforeClose = await getSession(repo, session.sessionId, alex.participantToken);
    expect(alexBeforeClose.submissions).toBeNull();

    const window = repo._allQuizWindows()[0];
    await closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken);

    // AFTER close: this is the exact state that produced the live leak
    // (currentInteraction now RESULT_REVEAL). The raw `submissions`
    // field itself — not just currentQuiz — must never carry the other
    // participant's answer, in either direction, nor to the host.
    const alexAfterClose = await getSession(repo, session.sessionId, alex.participantToken);
    const jordanAfterClose = await getSession(repo, session.sessionId, jordan.participantToken);
    const hostAfterClose = await getSession(repo, session.sessionId, session.hostToken);

    expect(alexAfterClose.submissions).toBeNull();
    expect(jordanAfterClose.submissions).toBeNull();
    expect(hostAfterClose.submissions).toBeNull();

    // Authorized aggregate results remain visible, as required —
    // standings (score/rank-equivalent) are untouched by this guard;
    // both participants answered the last question incorrectly here
    // (correct option is 2; Alex chose 0, Jordan chose 1), so both
    // legitimately score 0 for it — the point is that `standings`
    // itself is present and computed, not suppressed like `submissions`.
    expect(alexAfterClose.standings.find((s) => s.participantId === alex.participantId)?.score).toBe(0);
    expect(alexAfterClose.standings.find((s) => s.participantId === jordan.participantId)?.score).toBe(0);
  });
});

describe("CLOSE_QUIZ", () => {
  it("manual host close transitions all Interaction Instances to RESULT_REVEAL and scores correct answers", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, instances } = await setupPreparedQuiz(repo).then(async (r) => {
      await startQuiz(repo, r.session.sessionId, r.session.hostToken, 120);
      return {
        ...r,
        instances: repo._allInteractionInstances().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    });

    // Alex: Q1 correct (0), Q2 wrong (0, correct is 1), Q3 unanswered.
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0);
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[1].interactionInstanceId, 0);
    // Jordan: Q1 wrong (1), Q2 correct (1), Q3 correct (2).
    await submitQuizResponse(repo, session.sessionId, jordan.participantToken, instances[0].interactionInstanceId, 1);
    await submitQuizResponse(repo, session.sessionId, jordan.participantToken, instances[1].interactionInstanceId, 1);
    await submitQuizResponse(repo, session.sessionId, jordan.participantToken, instances[2].interactionInstanceId, 2);

    const window = repo._allQuizWindows()[0];
    const result = await closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken);

    expect(result.alreadyClosed).toBe(false);
    expect(repo._allInteractionInstances().every((i) => i.state === "RESULT_REVEAL")).toBe(true);

    const finalView = await getSession(repo, session.sessionId, session.hostToken);
    const alexStanding = finalView.standings.find((s) => s.participantId === alex.participantId);
    const jordanStanding = finalView.standings.find((s) => s.participantId === jordan.participantId);
    // Alex: Q1 correct (10). Q2 wrong, Q3 unanswered -> zero each.
    expect(alexStanding?.score).toBe(10);
    // Jordan: Q2 correct (10) + Q3 correct (15). Q1 wrong -> zero.
    expect(jordanStanding?.score).toBe(25);
  });

  it("is idempotent: a second close returns the same closedAt and performs no further work", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, instances } = await setupPreparedQuiz(repo).then(async (r) => {
      await startQuiz(repo, r.session.sessionId, r.session.hostToken, 120);
      return {
        ...r,
        instances: repo._allInteractionInstances().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    });
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0);

    const window = repo._allQuizWindows()[0];
    const first = await closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken);
    const awardsAfterFirst = [...(await repo.getPointAwardsForSession(session.sessionId))];

    const second = await closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken);

    expect(second.alreadyClosed).toBe(true);
    expect(second.closedAt).toBe(first.closedAt);
    const awardsAfterSecond = await repo.getPointAwardsForSession(session.sessionId);
    expect(awardsAfterSecond).toHaveLength(awardsAfterFirst.length);
  });

  it("concurrent duplicate close: exactly one finalization, idempotent replay for the other", async () => {
    const repo = new InMemorySessionRepository();
    const { session, instances } = await setupPreparedQuiz(repo).then(async (r) => {
      await startQuiz(repo, r.session.sessionId, r.session.hostToken, 120);
      return { ...r, instances: repo._allInteractionInstances() };
    });
    const window = repo._allQuizWindows()[0];

    const [a, b] = await Promise.all([
      closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken),
      closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken),
    ]);

    expect([a.alreadyClosed, b.alreadyClosed].filter((v) => v === false)).toHaveLength(1);
    expect(a.closedAt).toBe(b.closedAt);
    expect(instances.length).toBeGreaterThan(0);
  });

  it("expiry close: a participant may close only once the deadline has passed", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupPreparedQuiz(repo);
    await startQuiz(repo, session.sessionId, session.hostToken, 120);
    const window = repo._allQuizWindows()[0];

    await expect(
      closeQuiz(repo, session.sessionId, window.segmentId, alex.participantToken)
    ).rejects.toBeInstanceOf(QuizExpiryNotReachedError);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 121_000);

    const result = await closeQuiz(repo, session.sessionId, window.segmentId, alex.participantToken);
    expect(result.alreadyClosed).toBe(false);
  });

  it("rejects a caller token matching neither the host nor any participant", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);
    await startQuiz(repo, session.sessionId, session.hostToken, 120);
    const window = repo._allQuizWindows()[0];

    await expect(
      closeQuiz(repo, session.sessionId, window.segmentId, "not-a-real-token")
    ).rejects.toBeInstanceOf(QuizAccessDeniedError);
  });

  it("rejects a segmentId that is not a Quiz Segment of this session", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Not a Quiz",
    });
    const nonQuizSegment = repo._allSegments()[0];

    await expect(
      closeQuiz(repo, session.sessionId, nonQuizSegment.segmentId, session.hostToken)
    ).rejects.toBeInstanceOf(QuizNotFoundError);
  });

  it("unanswered questions produce no point_award (zero, not a special-cased row)", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);
    await startQuiz(repo, session.sessionId, session.hostToken, 120);
    const window = repo._allQuizWindows()[0];

    await closeQuiz(repo, session.sessionId, window.segmentId, session.hostToken);

    const awards = await repo.getPointAwardsForSession(session.sessionId);
    expect(awards).toHaveLength(0);
    const finalView = await getSession(repo, session.sessionId, session.hostToken);
    expect(finalView.standings.every((s) => s.score === 0)).toBe(true);
  });
});

describe("Quiz/Trivia Segment isolation regression", () => {
  it("starting Trivia after a Quiz closes with prepared questions remaining creates a NEW Segment, distinct from the Quiz's own Segment", async () => {
    // Regression coverage for a real defect found during browser
    // simulation: host.html's client-side "Trivia auto-continue" logic
    // checked only engineType/state/hasNextQuestion, without excluding
    // a just-closed Quiz (whose own Interaction Instances are also
    // engineType MULTIPLE_CHOICE / state RESULT_REVEAL) — so if a
    // prepared question was added to the queue after a Quiz closed, the
    // client silently continued as "Next Question" via
    // startSession(CURRENT_SEGMENT), reusing the Quiz's own Segment for
    // unrelated Trivia content. The client-side decision bug itself
    // lives in host.html, which has no DOM/unit test harness in this
    // repository (no jsdom/testing-library dependency exists) — so this
    // test instead proves the structural invariant a correctly-behaving
    // client depends on: starting a fresh Turn (startSession's default
    // NEW_SEGMENT target — exactly what "Choose Turn Type → Start
    // Trivia" invokes) after a Quiz close, in the exact state that
    // triggered the defect (Quiz closed, a prepared question left
    // unconsumed), is guaranteed to open a genuinely new Segment and to
    // read back as fully separate from the Quiz — never silently
    // reusing or being mistaken for the Quiz's own Segment.
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedQuiz(repo);
    const quizResult = await startQuiz(repo, session.sessionId, session.hostToken, 120);

    await closeQuiz(repo, session.sessionId, quizResult.segmentId, session.hostToken);

    // A prepared question is added AFTER the Quiz has already closed —
    // reproducing the exact "hasNextQuestion === true" condition that
    // triggered the client-side defect.
    await prepareQuestions(repo, session.sessionId, session.hostToken, [
      { promptText: "Leftover?", options: ["A", "B"], correctOptionIndex: 0, points: 10 },
    ]);
    const leftover = (await repo.getPreparedQuestionsForSession(session.sessionId)).find(
      (q) => q.consumedAt === null
    )!;

    const trivia = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: leftover.preparedQuestionId,
    });

    const triviaInstance = repo
      ._allInteractionInstances()
      .find((i) => i.interactionInstanceId === trivia.interactionInstanceId)!;

    // The Segment identity assertion: the new Trivia Turn's Segment must
    // never equal the Quiz's Segment.
    expect(triviaInstance.segmentId).not.toBe(quizResult.segmentId);
    expect(repo._allSegments()).toHaveLength(2);
    expect(trivia.segmentNumber).toBe(2);

    // The read model must not treat the new Trivia state as the prior
    // (closed, different) Quiz — currentQuiz must resolve to null now
    // that the current Interaction Instance belongs to a non-Quiz
    // Segment, and the host's current interaction must point at the new
    // Trivia instance, not anything Quiz-derived.
    const hostView = await getSession(repo, session.sessionId, session.hostToken);
    expect(hostView.currentQuiz).toBeNull();
    expect(hostView.currentInteractionInstanceId).toBe(trivia.interactionInstanceId);
    expect(hostView.segmentNumber).toBe(2);
  });
});

describe("host.html Quiz form collapse CSS regression", () => {
  // Regression coverage for a real (lower-severity, cosmetic) defect
  // found live: the Quiz Turn Type form's duration input remained
  // visible even at LOBBY_OPEN because the CSS rule collapsing
  // `#quizStartForm` when it carries the `collapsed` class was never
  // written — the JS toggled the class correctly, but nothing hid the
  // element. This repository has no DOM/render test harness (no
  // jsdom or @testing-library dependency exists anywhere in
  // package.json), so a real rendering assertion isn't available
  // without introducing a new testing framework for a single cosmetic
  // rule — judged disproportionate for this severity. This is instead
  // a focused static assertion the existing plain-Node Vitest setup
  // already supports: it reads the actual shipped host.html source and
  // confirms both halves of the fix are present together — the JS
  // still toggles the class, and a matching CSS rule still collapses
  // it — so a future edit that reintroduces just one half (exactly
  // what happened originally) fails this test.
  it("public/host.html defines a CSS rule collapsing #quizStartForm when it carries the collapsed class", () => {
    const hostHtml = readFileSync(
      join(__dirname, "..", "public", "host.html"),
      "utf8"
    );

    expect(hostHtml).toMatch(/#quizStartForm\.collapsed\s*\{\s*display:\s*none;?\s*\}/);
    expect(hostHtml).toMatch(/quizForm\.classList\.(toggle|add)\(["']collapsed["']/);
  });
});

describe("Reconnect", () => {
  it("progress is re-derived from server-authoritative submissions, not stored per-participant state", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, instances } = await setupPreparedQuiz(repo).then(async (r) => {
      await startQuiz(repo, r.session.sessionId, r.session.hostToken, 120);
      return {
        ...r,
        instances: repo._allInteractionInstances().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    });

    await submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[0].interactionInstanceId, 0);
    const firstView = await getSession(repo, session.sessionId, alex.participantToken);
    expect(firstView.currentQuiz?.myProgress).toEqual({ answered: 1, total: 3 });

    // Simulates a reconnect: an entirely fresh GET_SESSION call with no
    // client-side state carried over — the repository itself has no
    // "current question" concept to forget, so this is simply a second
    // call, and it must derive the identical, correct answer.
    await submitQuizResponse(repo, session.sessionId, alex.participantToken, instances[1].interactionInstanceId, 1);
    const secondView = await getSession(repo, session.sessionId, alex.participantToken);
    expect(secondView.currentQuiz?.myProgress).toEqual({ answered: 2, total: 3 });

    const q1 = secondView.currentQuiz?.questions?.find(
      (q) => q.interactionInstanceId === instances[0].interactionInstanceId
    );
    const q3 = secondView.currentQuiz?.questions?.find(
      (q) => q.interactionInstanceId === instances[2].interactionInstanceId
    );
    expect(q1?.answered).toBe(true);
    expect(q3?.answered).toBe(false);
  });
});
