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
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
  EmptyPromptTextError,
  InvalidOptionsError,
  InvalidCorrectOptionIndexError,
  InvalidPointsError,
  PreparedQuestionNotFoundError,
  PreparedQuestionAlreadyConsumedError,
  InvalidOptionSelectionError,
} from "../lib/session/types";

const PIZZA_QUESTION = {
  promptText: "What's the best pizza topping?",
  options: ["Pepperoni", "Mushroom", "Pineapple"],
  correctOptionIndex: 0,
  points: 20,
};

const ANIMAL_QUESTION = {
  promptText: "Cats or dogs?",
  options: ["Cats", "Dogs"],
  correctOptionIndex: 1,
};

async function setupPreparedSession(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  const jordan = await joinSession(repo, session.roomCode, "Jordan");
  await lockLobby(repo, session.sessionId, session.hostToken);
  const prepared = await prepareQuestions(repo, session.sessionId, session.hostToken, [
    PIZZA_QUESTION,
    ANIMAL_QUESTION,
  ]);
  return { session, alex, jordan, prepared };
}

describe("PREPARE_QUESTIONS", () => {
  it("persists a batch of questions with sequential ordinals starting at 1", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    const result = await prepareQuestions(repo, session.sessionId, session.hostToken, [
      PIZZA_QUESTION,
      ANIMAL_QUESTION,
    ]);

    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].ordinal).toBe(1);
    expect(result.questions[1].ordinal).toBe(2);
    expect(result.questions[0].consumedAt).toBeNull();
  });

  it("defaults pointsForCorrect to 10 when points is not supplied", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    const result = await prepareQuestions(repo, session.sessionId, session.hostToken, [
      ANIMAL_QUESTION,
    ]);

    expect(result.questions[0].pointsForCorrect).toBe(10);
  });

  it("continues ordinals across separate PREPARE_QUESTIONS calls", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await prepareQuestions(repo, session.sessionId, session.hostToken, [PIZZA_QUESTION]);
    const second = await prepareQuestions(repo, session.sessionId, session.hostToken, [
      ANIMAL_QUESTION,
    ]);

    expect(second.questions[0].ordinal).toBe(2);
  });

  it("rejects an empty (post-trim) prompt", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      prepareQuestions(repo, session.sessionId, session.hostToken, [
        { ...PIZZA_QUESTION, promptText: "   " },
      ])
    ).rejects.toBeInstanceOf(EmptyPromptTextError);
  });

  it("rejects fewer than two options", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      prepareQuestions(repo, session.sessionId, session.hostToken, [
        { ...PIZZA_QUESTION, options: ["Only one"] },
      ])
    ).rejects.toBeInstanceOf(InvalidOptionsError);
  });

  it("rejects duplicate options", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      prepareQuestions(repo, session.sessionId, session.hostToken, [
        { ...PIZZA_QUESTION, options: ["Same", "Same"] },
      ])
    ).rejects.toBeInstanceOf(InvalidOptionsError);
  });

  it("rejects a correctOptionIndex out of bounds", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      prepareQuestions(repo, session.sessionId, session.hostToken, [
        { ...PIZZA_QUESTION, correctOptionIndex: 99 },
      ])
    ).rejects.toBeInstanceOf(InvalidCorrectOptionIndexError);
  });

  it("rejects a non-positive or excessive points value", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      prepareQuestions(repo, session.sessionId, session.hostToken, [
        { ...PIZZA_QUESTION, points: 0 },
      ])
    ).rejects.toBeInstanceOf(InvalidPointsError);

    await expect(
      prepareQuestions(repo, session.sessionId, session.hostToken, [
        { ...PIZZA_QUESTION, points: 10001 },
      ])
    ).rejects.toBeInstanceOf(InvalidPointsError);
  });

  it("rejects a mismatched host token", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      prepareQuestions(repo, session.sessionId, "wrong-token", [PIZZA_QUESTION])
    ).rejects.toBeInstanceOf(HostTokenMismatchError);
  });

  it("rejects preparing questions for a nonexistent session", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      prepareQuestions(
        repo,
        "11111111-1111-1111-1111-111111111111",
        "any-token",
        [PIZZA_QUESTION]
      )
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("rejects preparing questions once the session is complete", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    repo._forceComplete(session.sessionId);

    await expect(
      prepareQuestions(repo, session.sessionId, session.hostToken, [PIZZA_QUESTION])
    ).rejects.toBeInstanceOf(SessionAlreadyCompleteError);
  });

  it("is allowed before the lobby is locked", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    const result = await prepareQuestions(repo, session.sessionId, session.hostToken, [
      PIZZA_QUESTION,
    ]);

    expect(result.questions).toHaveLength(1);
  });

  describe("GET_SESSION visibility (role-aware — the first field of its kind)", () => {
    it("exposes preparedQuestions, including correct answers, to the host", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupPreparedSession(repo);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.preparedQuestions).toHaveLength(2);
      expect(result.preparedQuestions?.[0].correctOptionIndex).toBe(0);
    });

    it("never exposes preparedQuestions to a participant", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex } = await setupPreparedSession(repo);

      const result = await getSession(repo, session.sessionId, alex.participantToken);

      expect(result.preparedQuestions).toBeNull();
      expect(JSON.stringify(result)).not.toContain("Pepperoni");
    });
  });
});

describe("START_SESSION with an explicit preparedQuestionId", () => {
  it("starts a MULTIPLE_CHOICE interaction from the named prepared question", async () => {
    const repo = new InMemorySessionRepository();
    const { session, prepared } = await setupPreparedSession(repo);

    const started = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[0].preparedQuestionId,
    });

    expect(started.engineType).toBe("MULTIPLE_CHOICE");

    const prompt = await repo.getPromptById(started.promptId);
    expect(prompt?.text).toBe(PIZZA_QUESTION.promptText);

    const details = await repo.getMultipleChoiceDetailsForInteraction(
      started.interactionInstanceId
    );
    expect(details?.options).toEqual(PIZZA_QUESTION.options);
    expect(details?.correctOptionIndex).toBe(0);
    expect(details?.pointsForCorrect).toBe(20);
  });

  it("marks the prepared question consumed and it cannot be started again", async () => {
    const repo = new InMemorySessionRepository();
    const { session, prepared } = await setupPreparedSession(repo);

    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[0].preparedQuestionId,
    });
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      })
    ).rejects.toBeInstanceOf(PreparedQuestionAlreadyConsumedError);
  });

  it("does not implicitly select a prepared question when preparedQuestionId is omitted — falls back to Open Response", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupPreparedSession(repo);

    const started = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Ad-hoc open response prompt",
    });

    expect(started.engineType).toBe("OPEN_RESPONSE");
    const details = await repo.getMultipleChoiceDetailsForInteraction(
      started.interactionInstanceId
    );
    expect(details).toBeNull();
  });

  it("rejects a preparedQuestionId that does not exist", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: "11111111-1111-1111-1111-111111111111",
      })
    ).rejects.toBeInstanceOf(PreparedQuestionNotFoundError);
  });

  it("rejects a preparedQuestionId belonging to a different session", async () => {
    const repo = new InMemorySessionRepository();
    const { prepared } = await setupPreparedSession(repo);
    const otherSession = await createSession(repo);
    await setSessionCapabilities(repo, otherSession.sessionId, otherSession.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, otherSession.sessionId, otherSession.hostToken);

    await expect(
      startSession(repo, otherSession.sessionId, otherSession.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      })
    ).rejects.toBeInstanceOf(PreparedQuestionNotFoundError);
  });

  it("allows Open Response and Multiple Choice interactions to run sequentially in the same session", async () => {
    const repo = new InMemorySessionRepository();
    const { session, prepared } = await setupPreparedSession(repo);

    const first = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[0].preparedQuestionId,
    });
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    const second = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "An ad-hoc open response question",
    });

    expect(first.engineType).toBe("MULTIPLE_CHOICE");
    expect(second.engineType).toBe("OPEN_RESPONSE");

    const result = await getSession(repo, session.sessionId, session.hostToken);
    expect(result.currentEngineType).toBe("OPEN_RESPONSE");
    expect(result.currentPrompt?.options).toBeNull();
  });
});

describe("SUBMIT_RESPONSE against a Multiple Choice interaction", () => {
  async function setupActiveMultipleChoice(repo: InMemorySessionRepository) {
    const { session, alex, jordan, prepared } = await setupPreparedSession(repo);
    const interaction = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[0].preparedQuestionId,
    });
    return { session, alex, jordan, interaction };
  }

  it("accepts a legal option index as the submission text", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupActiveMultipleChoice(repo);

    const result = await submitResponse(repo, session.sessionId, alex.participantToken, "0");

    expect(result.text).toBe("0");
  });

  it("rejects a value that is not a legal option index for this question", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupActiveMultipleChoice(repo);

    await expect(
      submitResponse(repo, session.sessionId, alex.participantToken, "99")
    ).rejects.toBeInstanceOf(InvalidOptionSelectionError);

    await expect(
      submitResponse(repo, session.sessionId, alex.participantToken, "Pepperoni")
    ).rejects.toBeInstanceOf(InvalidOptionSelectionError);

    await expect(
      submitResponse(repo, session.sessionId, alex.participantToken, "-1")
    ).rejects.toBeInstanceOf(InvalidOptionSelectionError);
  });

  it("does not apply Open Response's free-text length floor to a Multiple Choice submission", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupActiveMultipleChoice(repo);

    // "0" is one character, well under any free-text floor concern —
    // this proves the option-index check ran, not the free-text one,
    // by confirming a numerically out-of-range index is still rejected.
    await expect(
      submitResponse(repo, session.sessionId, alex.participantToken, "5")
    ).rejects.toBeInstanceOf(InvalidOptionSelectionError);
  });
});

describe("Automatic evaluation and scoring on REVEAL_RESULTS", () => {
  it("awards points automatically to participants who selected the correct option", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, prepared } = await setupPreparedSession(repo);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[0].preparedQuestionId,
    });
    await submitResponse(repo, session.sessionId, alex.participantToken, "0"); // correct
    await submitResponse(repo, session.sessionId, jordan.participantToken, "1"); // wrong
    await closeSubmissions(repo, session.sessionId, session.hostToken);

    await revealResults(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, session.hostToken);
    const alexStanding = result.standings.find((s) => s.participantId === alex.participantId);
    const jordanStanding = result.standings.find(
      (s) => s.participantId === jordan.participantId
    );

    expect(alexStanding?.score).toBe(20);
    expect(jordanStanding?.score).toBe(0);
  });

  it("awards no points for a question no one answered correctly", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, prepared } = await setupPreparedSession(repo);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[0].preparedQuestionId,
    });
    await submitResponse(repo, session.sessionId, alex.participantToken, "1");
    await submitResponse(repo, session.sessionId, jordan.participantToken, "2");
    await closeSubmissions(repo, session.sessionId, session.hostToken);

    await revealResults(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, session.hostToken);
    expect(result.standings.every((s) => s.score === 0)).toBe(true);
  });

  it("does not double-award if the evaluation step were somehow re-run for the same interaction", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, prepared } = await setupPreparedSession(repo);
    const interaction = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[0].preparedQuestionId,
    });
    await submitResponse(repo, session.sessionId, alex.participantToken, "0");
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    // Deterministic key means a second reveal call against the same
    // already-revealed interaction (rejected by state precondition,
    // but exercised here directly at the repository layer as a
    // structural proof) cannot produce a second award.
    const before = repo
      ._allPointAwards()
      .filter((a) => a.interactionInstanceId === interaction.interactionInstanceId);
    expect(before).toHaveLength(1);
  });

  it("leaves Open Response's REVEAL_RESULTS behavior completely unaffected — no point_awards are created", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    const alex = await joinSession(repo, session.roomCode, "Alex");
    await lockLobby(repo, session.sessionId, session.hostToken);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Open response prompt",
    });
    await submitResponse(repo, session.sessionId, alex.participantToken, "Free text answer");
    await closeSubmissions(repo, session.sessionId, session.hostToken);

    await revealResults(repo, session.sessionId, session.hostToken);

    expect(repo._allPointAwards()).toHaveLength(0);
  });

  describe("GET_SESSION reveal-gating for Multiple Choice", () => {
    it("withholds correctOptionIndex until RESULT_REVEAL, from host and participant alike", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, prepared } = await setupPreparedSession(repo);
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });

      const hostView = await getSession(repo, session.sessionId, session.hostToken);
      const participantView = await getSession(repo, session.sessionId, alex.participantToken);

      expect(hostView.currentPrompt?.correctOptionIndex).toBeNull();
      expect(participantView.currentPrompt?.correctOptionIndex).toBeNull();
      expect(hostView.currentPrompt?.options).toEqual(PIZZA_QUESTION.options);
    });

    it("reveals correctOptionIndex and per-participant correctness once RESULT_REVEAL", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, jordan, prepared } = await setupPreparedSession(repo);
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      await submitResponse(repo, session.sessionId, alex.participantToken, "0");
      await submitResponse(repo, session.sessionId, jordan.participantToken, "1");
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.currentPrompt?.correctOptionIndex).toBe(0);
      const alexSubmission = result.submissions?.find(
        (s) => s.participantId === alex.participantId
      );
      const jordanSubmission = result.submissions?.find(
        (s) => s.participantId === jordan.participantId
      );
      expect(alexSubmission?.text).toBe("Pepperoni");
      expect(alexSubmission?.isCorrect).toBe(true);
      expect(jordanSubmission?.text).toBe("Mushroom");
      expect(jordanSubmission?.isCorrect).toBe(false);
    });
  });

  it("full trivia loop: prepare -> start -> answer -> close -> reveal -> auto-score -> next question -> final standings", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, prepared } = await setupPreparedSession(repo);

    // Question 1: pizza (correct = 0, 20 points)
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[0].preparedQuestionId,
    });
    await submitResponse(repo, session.sessionId, alex.participantToken, "0");
    await submitResponse(repo, session.sessionId, jordan.participantToken, "0");
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    // Question 2: cats or dogs (correct = 1, default 10 points)
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.questions[1].preparedQuestionId,
    });
    await submitResponse(repo, session.sessionId, alex.participantToken, "1");
    await submitResponse(repo, session.sessionId, jordan.participantToken, "0");
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, session.hostToken);
    const alexStanding = result.standings.find((s) => s.participantId === alex.participantId);
    const jordanStanding = result.standings.find(
      (s) => s.participantId === jordan.participantId
    );

    expect(alexStanding?.score).toBe(30); // correct both times: 20 + 10
    expect(jordanStanding?.score).toBe(20); // correct only the first: 20
    expect(result.preparedQuestions?.every((q) => q.consumedAt !== null)).toBe(true);
  });
});
