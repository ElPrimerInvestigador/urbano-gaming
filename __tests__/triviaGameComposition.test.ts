import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { submitResponse } from "../lib/session/submitResponse";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { prepareQuestions } from "../lib/session/prepareQuestions";
import { completeSession } from "../lib/session/completeSession";
import { createSuccessorSession } from "../lib/session/createSuccessorSession";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  PromptNotActiveError,
  SubmissionsNotClosedError,
} from "../lib/session/types";

/**
 * Trivia Game composition correction (post-Slice-009 founder
 * production-playtest follow-up). Founder playtest evidence: a real
 * 10-question Trivia set rendered as ten separate "Turn 1..10", each
 * with its own Segment — one Interaction Instance's worth of
 * standings, not a coherent Trivia Game. Canonical architecture
 * evidence (Session_Architecture.md's "a future Experience design
 * remains free to group ... (ten Trivia questions) into one segment",
 * and Runtime_Architecture.md's Trivia example) already described one
 * Segment holding every question of a Trivia Game as the intended
 * model — CURRENT_SEGMENT (Slice 008/0037) already supports this for
 * any engine type, so this is a composition/orchestration correction,
 * not a schema or migration change. See
 * TRIVIA_GAME_COMPOSITION_IMPLEMENTATION_RECORD.md.
 */

const Q1 = {
  promptText: "What's the best pizza topping?",
  options: ["Pepperoni", "Mushroom", "Pineapple"],
  correctOptionIndex: 0,
  points: 20,
};
const Q2 = {
  promptText: "Cats or dogs?",
  options: ["Cats", "Dogs"],
  correctOptionIndex: 1,
  points: 10,
};
const Q3 = {
  promptText: "Sun or moon?",
  options: ["Sun", "Moon"],
  correctOptionIndex: 0,
  points: 15,
};

async function setupPreparedTrivia(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  const jordan = await joinSession(repo, session.roomCode, "Jordan");
  await lockLobby(repo, session.sessionId, session.hostToken);
  const prepared = await prepareQuestions(repo, session.sessionId, session.hostToken, [
    Q1,
    Q2,
    Q3,
  ]);
  return { session, alex, jordan, prepared };
}

/** Mirrors host.html's triviaNextQuestion(): close -> reveal -> start next in CURRENT_SEGMENT. */
async function advanceToNextQuestion(
  repo: InMemorySessionRepository,
  sessionId: string,
  hostToken: string,
  nextPreparedQuestionId: string
) {
  await closeSubmissions(repo, sessionId, hostToken);
  await revealResults(repo, sessionId, hostToken);
  return startSession(
    repo,
    sessionId,
    hostToken,
    { engineType: "MULTIPLE_CHOICE", preparedQuestionId: nextPreparedQuestionId },
    "CURRENT_SEGMENT"
  );
}

describe("Trivia Game composition correction", () => {
  describe("Composition: one Segment holds every question of the Trivia Game", () => {
    it("Question 1 starts a NEW_SEGMENT; Questions 2..N attach to the same Segment via CURRENT_SEGMENT", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      const q1 = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      expect(q1.segmentNumber).toBe(1);

      const q2 = await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[1].preparedQuestionId
      );
      expect(q2.segmentNumber).toBe(1);

      const q3 = await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[2].preparedQuestionId
      );
      expect(q3.segmentNumber).toBe(1);

      // Whole Trivia Game is exactly one Segment...
      expect(repo._allSegments()).toHaveLength(1);
      // ...containing exactly three Multiple Choice Interaction Instances.
      const instances = repo._allInteractionInstances();
      expect(instances).toHaveLength(3);
      expect(new Set(instances.map((i) => i.segmentId)).size).toBe(1);
    });

    it("segmentNumber stays constant while interactionNumber advances per question", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      let result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.segmentNumber).toBe(1);
      expect(result.interactionNumber).toBe(1);

      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[1].preparedQuestionId
      );
      result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.segmentNumber).toBe(1);
      expect(result.interactionNumber).toBe(2);

      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[2].preparedQuestionId
      );
      result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.segmentNumber).toBe(1);
      expect(result.interactionNumber).toBe(3);
    });

    it("a Trivia Game started after a prior, already-completed Turn still opens its own NEW_SEGMENT", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      // An unrelated prior Turn (e.g. an Open Response ad-hoc question).
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Warm-up question",
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const q1 = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });

      expect(q1.segmentNumber).toBe(2);
      expect(repo._allSegments()).toHaveLength(2);
    });
  });

  describe("questionProgress read model", () => {
    it("is null for Open Response and for Voting", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      const alex = await joinSession(repo, session.roomCode, "Alex");
      await lockLobby(repo, session.sessionId, session.hostToken);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Tell us your best joke!",
      });
      const openResponseView = await getSession(repo, session.sessionId, alex.participantToken);
      expect(openResponseView.questionProgress).toBeNull();

      await submitResponse(repo, session.sessionId, alex.participantToken, "Knock knock.");
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const openResponseInteractionId = (
        await getSession(repo, session.sessionId, session.hostToken)
      ).currentInteractionInstanceId;

      await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        {
          engineType: "VOTING",
          promptText: "Vote for the funniest!",
          candidateSource: {
            type: "SUBMISSION",
            sourceInteractionInstanceId: openResponseInteractionId!,
          },
        },
        "CURRENT_SEGMENT"
      );
      const votingView = await getSession(repo, session.sessionId, alex.participantToken);
      expect(votingView.questionProgress).toBeNull();
    });

    it("reports current=1,total=N immediately after Question 1 starts, to host and participant alike", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });

      const hostView = await getSession(repo, session.sessionId, session.hostToken);
      const participantView = await getSession(repo, session.sessionId, alex.participantToken);

      expect(hostView.questionProgress).toEqual({ current: 1, total: 3 });
      expect(participantView.questionProgress).toEqual({ current: 1, total: 3 });
    });

    it("reports current=N,total=N once the final question has started, and stays there through RESULT_REVEAL", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[1].preparedQuestionId
      );
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[2].preparedQuestionId
      );

      let participantView = await getSession(repo, session.sessionId, alex.participantToken);
      expect(participantView.questionProgress).toEqual({ current: 3, total: 3 });

      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      participantView = await getSession(repo, session.sessionId, alex.participantToken);
      expect(participantView.questionProgress).toEqual({ current: 3, total: 3 });
    });

    it("never leaks correctOptionIndex, option text, or any other prepared-question content to a participant", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });

      const participantView = await getSession(repo, session.sessionId, alex.participantToken);

      expect(participantView.preparedQuestions).toBeNull();
      expect(Object.keys(participantView.questionProgress!)).toEqual(
        expect.arrayContaining(["current", "total"])
      );
      expect(Object.keys(participantView.questionProgress!)).toHaveLength(2);
      // Neither the not-yet-asked questions' text nor the current
      // question's correct-answer index should be reachable anywhere
      // in the participant's serialized response.
      const serialized = JSON.stringify(participantView);
      expect(serialized).not.toContain("Cats or dogs");
      expect(serialized).not.toContain("Sun or moon");
      expect(participantView.currentPrompt?.correctOptionIndex).toBeNull();
    });
  });

  describe("Scoring across a multi-question Trivia Game (CURRENT_SEGMENT composition)", () => {
    it("final standings equal the sum of point_awards across all questions in the Segment", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, jordan, prepared } = await setupPreparedTrivia(repo);

      // Q1 (20 pts, correct=0): both correct.
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await submitResponse(repo, session.sessionId, alex.participantToken, "0");
      await submitResponse(repo, session.sessionId, jordan.participantToken, "0");

      // Q2 (10 pts, correct=1): only Alex correct.
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[1].preparedQuestionId
      );
      await submitResponse(repo, session.sessionId, alex.participantToken, "1");
      await submitResponse(repo, session.sessionId, jordan.participantToken, "0");

      // Q3 (15 pts, correct=0): only Jordan correct.
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[2].preparedQuestionId
      );
      await submitResponse(repo, session.sessionId, alex.participantToken, "1");
      await submitResponse(repo, session.sessionId, jordan.participantToken, "0");
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      const alexStanding = result.standings.find((s) => s.participantId === alex.participantId);
      const jordanStanding = result.standings.find(
        (s) => s.participantId === jordan.participantId
      );

      expect(alexStanding?.score).toBe(30); // 20 + 10
      expect(jordanStanding?.score).toBe(35); // 20 + 15
      expect(result.segmentNumber).toBe(1);
      expect(result.interactionNumber).toBe(3);
    });
  });

  describe("Next Question progression control (composed close -> reveal -> start-next)", () => {
    it("advances cleanly question over question without creating duplicate Segments or Interaction Instances", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[1].preparedQuestionId
      );
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[2].preparedQuestionId
      );

      expect(repo._allSegments()).toHaveLength(1);
      expect(repo._allInteractionInstances()).toHaveLength(3);
    });

    it("re-invoking close-submissions after it already succeeded fails honestly rather than silently duplicating state (resumability of the composed action)", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);

      // Simulates triviaNextQuestion() re-entering after a stale read of
      // interactionLifecycleState still said PROMPT_ACTIVE — the
      // underlying guard rejects the redundant close rather than
      // silently no-op'ing or double-processing.
      await expect(
        closeSubmissions(repo, session.sessionId, session.hostToken)
      ).rejects.toBeInstanceOf(PromptNotActiveError);

      // The composed action can still recover by proceeding straight to
      // reveal, since that step's own precondition (SUBMISSIONS_CLOSED)
      // is in fact satisfied.
      const revealed = await revealResults(repo, session.sessionId, session.hostToken);
      expect(revealed.interactionInstanceId).toBeDefined();
    });

    it("re-invoking reveal-results after it already succeeded fails honestly rather than silently duplicating state", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      await expect(
        revealResults(repo, session.sessionId, session.hostToken)
      ).rejects.toBeInstanceOf(SubmissionsNotClosedError);

      // A stale-tab re-click after RESULT_REVEAL can now safely proceed
      // straight to starting the next question in CURRENT_SEGMENT.
      const next = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        { engineType: "MULTIPLE_CHOICE", preparedQuestionId: prepared.questions[1].preparedQuestionId },
        "CURRENT_SEGMENT"
      );
      expect(next.segmentNumber).toBe(1);
    });

    it("double-click / concurrent Next Question at the start-next-question step: exactly one succeeds, no duplicate Interaction Instance is created", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const attempts = await Promise.allSettled([
        startSession(
          repo,
          session.sessionId,
          session.hostToken,
          { engineType: "MULTIPLE_CHOICE", preparedQuestionId: prepared.questions[1].preparedQuestionId },
          "CURRENT_SEGMENT"
        ),
        startSession(
          repo,
          session.sessionId,
          session.hostToken,
          { engineType: "MULTIPLE_CHOICE", preparedQuestionId: prepared.questions[1].preparedQuestionId },
          "CURRENT_SEGMENT"
        ),
      ]);

      const successes = attempts.filter((a) => a.status === "fulfilled");
      expect(successes).toHaveLength(1);

      expect(repo._allSegments()).toHaveLength(1);
      expect(repo._allInteractionInstances()).toHaveLength(2);
    });

    it("no next question available: the last prepared question, once revealed, leaves nothing further to consume", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[1].preparedQuestionId
      );
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[2].preparedQuestionId
      );
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      const unconsumed = result.preparedQuestions?.filter((q) => q.consumedAt === null);
      expect(unconsumed).toHaveLength(0);
      expect(result.questionProgress).toEqual({ current: 3, total: 3 });
    });
  });

  describe("Regression: rematch isolation for a Trivia Game", () => {
    it("a rematch (successor session) starts with zero Segments and its own independent prepared-question queue", async () => {
      const repo = new InMemorySessionRepository();
      const { session, prepared } = await setupPreparedTrivia(repo);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await advanceToNextQuestion(
        repo,
        session.sessionId,
        session.hostToken,
        prepared.questions[1].preparedQuestionId
      );
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);
      await completeSession(repo, session.sessionId, session.hostToken);

      const successor = await createSuccessorSession(
        repo,
        session.sessionId,
        session.hostToken
      );

      const successorSegments = await repo.getSegmentsForSession(successor.sessionId);
      expect(successorSegments).toHaveLength(0);

      const predecessorSegments = await repo.getSegmentsForSession(session.sessionId);
      expect(predecessorSegments).toHaveLength(1);

      // The predecessor's third, never-started prepared question does
      // not leak into or block the successor's own Trivia Game.
      await setSessionCapabilities(repo, successor.sessionId, successor.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await joinSession(repo, successor.roomCode, "Sam");
      await lockLobby(repo, successor.sessionId, successor.hostToken);
      const successorPrepared = await prepareQuestions(
        repo,
        successor.sessionId,
        successor.hostToken,
        [Q1]
      );
      const successorFirst = await startSession(repo, successor.sessionId, successor.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: successorPrepared.questions[0].preparedQuestionId,
      });
      expect(successorFirst.segmentNumber).toBe(1);
    });
  });
});
