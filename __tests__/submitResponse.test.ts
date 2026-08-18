import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { submitResponse } from "../lib/session/submitResponse";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  SessionAccessDeniedError,
  PromptNotActiveError,
  EmptyResponseError,
  ResponseTooLongError,
} from "../lib/session/types";

async function setupActiveSession(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  const participant = await joinSession(repo, session.roomCode, "Alex");
  await lockLobby(repo, session.sessionId, session.hostToken);
  const interaction = await startSession(repo, session.sessionId, session.hostToken, {
    engineType: "OPEN_RESPONSE",
    promptText: "Prompt text",
  });
  return { session, participant, interaction };
}

describe("SUBMIT_RESPONSE", () => {
  it("accepts an initial submission during PROMPT_ACTIVE", async () => {
    const repo = new InMemorySessionRepository();
    const { session, participant, interaction } = await setupActiveSession(repo);

    const result = await submitResponse(
      repo,
      session.sessionId,
      participant.participantToken,
      "Pizza night!"
    );

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.interactionInstanceId).toBe(interaction.interactionInstanceId);
    expect(result.participantId).toBe(participant.participantId);
    expect(result.text).toBe("Pizza night!");
    expect(result.submissionId).toBeTruthy();
  });

  it("revises a previous submission — last write wins", async () => {
    const repo = new InMemorySessionRepository();
    const { session, participant, interaction } = await setupActiveSession(repo);

    const first = await submitResponse(
      repo,
      session.sessionId,
      participant.participantToken,
      "First answer"
    );
    const second = await submitResponse(
      repo,
      session.sessionId,
      participant.participantToken,
      "Revised answer"
    );

    expect(second.submissionId).toBe(first.submissionId);
    expect(second.text).toBe("Revised answer");

    const submissions = await repo.getSubmissionsForInteractionInstance(
      interaction.interactionInstanceId
    );
    expect(submissions).toHaveLength(1);
    expect(submissions[0].text).toBe("Revised answer");
  });

  it("rejects a token that matches no participant of this session", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupActiveSession(repo);

    await expect(
      submitResponse(repo, session.sessionId, "unrelated-token", "Hi")
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects the host's own token — no host fallback", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupActiveSession(repo);

    await expect(
      submitResponse(repo, session.sessionId, session.hostToken, "Hi")
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects a participant token scoped to a different session", async () => {
    const repo = new InMemorySessionRepository();
    const { session: sessionA } = await setupActiveSession(repo);
    const sessionB = await createSession(repo);
    const participantOfB = await joinSession(repo, sessionB.roomCode, "Jordan");

    await expect(
      submitResponse(repo, sessionA.sessionId, participantOfB.participantToken, "Hi")
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects submitting before any interaction has started (LOBBY_LOCKED)", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    const participant = await joinSession(repo, session.roomCode, "Alex");
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      submitResponse(repo, session.sessionId, participant.participantToken, "Hi")
    ).rejects.toBeInstanceOf(PromptNotActiveError);
  });

  it("rejects an empty (post-trim) response", async () => {
    const repo = new InMemorySessionRepository();
    const { session, participant } = await setupActiveSession(repo);

    await expect(
      submitResponse(repo, session.sessionId, participant.participantToken, "   ")
    ).rejects.toBeInstanceOf(EmptyResponseError);
  });

  it("rejects a response exceeding 1000 characters after trimming", async () => {
    const repo = new InMemorySessionRepository();
    const { session, participant } = await setupActiveSession(repo);

    await expect(
      submitResponse(
        repo,
        session.sessionId,
        participant.participantToken,
        "a".repeat(1001)
      )
    ).rejects.toBeInstanceOf(ResponseTooLongError);
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      submitResponse(
        repo,
        "11111111-1111-1111-1111-111111111111",
        "any-token",
        "Hi"
      )
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("does not affect other participants' submissions", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    const alex = await joinSession(repo, session.roomCode, "Alex");
    const jordan = await joinSession(repo, session.roomCode, "Jordan");
    await lockLobby(repo, session.sessionId, session.hostToken);
    const interaction = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt text",
    });

    await submitResponse(repo, session.sessionId, alex.participantToken, "Alex's answer");
    await submitResponse(repo, session.sessionId, jordan.participantToken, "Jordan's answer");

    const submissions = await repo.getSubmissionsForInteractionInstance(
      interaction.interactionInstanceId
    );
    expect(submissions).toHaveLength(2);
  });

  describe("concurrency", () => {
    it("in-memory proof: concurrent submissions from the same participant do not duplicate — exactly one submission survives", async () => {
      const repo = new InMemorySessionRepository();
      const { session, participant, interaction } = await setupActiveSession(repo);

      await Promise.allSettled([
        submitResponse(repo, session.sessionId, participant.participantToken, "A"),
        submitResponse(repo, session.sessionId, participant.participantToken, "B"),
      ]);

      const submissions = await repo.getSubmissionsForInteractionInstance(
        interaction.interactionInstanceId
      );
      expect(submissions).toHaveLength(1);
    });
  });

  describe("repository-level authority", () => {
    it("in-memory proof: submitResponse independently rejects a session that is not PROMPT_ACTIVE, even when called directly", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      const participant = await joinSession(repo, session.roomCode, "Alex");

      await expect(
        repo.submitResponse(
          session.sessionId,
          participant.participantId,
          participant.participantToken,
          "Hi"
        )
      ).rejects.toBeInstanceOf(PromptNotActiveError);
    });

    it("in-memory proof: submitResponse independently rejects a mismatched token, even when called directly", async () => {
      const repo = new InMemorySessionRepository();
      const { session, participant } = await setupActiveSession(repo);

      await expect(
        repo.submitResponse(
          session.sessionId,
          participant.participantId,
          "wrong-token",
          "Hi"
        )
      ).rejects.toBeInstanceOf(SessionAccessDeniedError);
    });
  });

  describe("GET_SESSION integration", () => {
    it("submittedCount reflects submissions during PROMPT_ACTIVE without exposing text", async () => {
      const repo = new InMemorySessionRepository();
      const { session, participant } = await setupActiveSession(repo);
      await submitResponse(repo, session.sessionId, participant.participantToken, "Secret answer");

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.submittedCount).toBe(1);
      expect(result.eligibleParticipantCount).toBe(1);
      expect(result.submissions).toBeNull();
      expect(JSON.stringify(result)).not.toContain("Secret answer");
    });
  });

  describe("sequential interactions", () => {
    it("a submission is scoped to the interaction instance active at submission time, not reused by a later interaction", async () => {
      const repo = new InMemorySessionRepository();
      const { session, participant, interaction: firstInteraction } =
        await setupActiveSession(repo);
      await submitResponse(
        repo,
        session.sessionId,
        participant.participantToken,
        "Answer to first prompt"
      );
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const secondInteraction = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      });

      const firstSubmissions = await repo.getSubmissionsForInteractionInstance(
        firstInteraction.interactionInstanceId
      );
      const secondSubmissions = await repo.getSubmissionsForInteractionInstance(
        secondInteraction.interactionInstanceId
      );

      expect(firstSubmissions).toHaveLength(1);
      expect(secondSubmissions).toHaveLength(0);
    });

    it("the same participant can submit again to a new interaction after the first was revealed", async () => {
      const repo = new InMemorySessionRepository();
      const { session, participant } = await setupActiveSession(repo);
      await submitResponse(
        repo,
        session.sessionId,
        participant.participantToken,
        "First answer"
      );
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      });

      const result = await submitResponse(
        repo,
        session.sessionId,
        participant.participantToken,
        "Second answer"
      );

      expect(result.text).toBe("Second answer");

      const getResult = await getSession(repo, session.sessionId, session.hostToken);
      expect(getResult.submittedCount).toBe(1);
    });

    it("rejects a submission attempt while the current interaction is SUBMISSIONS_CLOSED or RESULT_REVEAL", async () => {
      const repo = new InMemorySessionRepository();
      const { session, participant } = await setupActiveSession(repo);
      await closeSubmissions(repo, session.sessionId, session.hostToken);

      await expect(
        submitResponse(repo, session.sessionId, participant.participantToken, "Too late")
      ).rejects.toBeInstanceOf(PromptNotActiveError);

      await revealResults(repo, session.sessionId, session.hostToken);

      await expect(
        submitResponse(repo, session.sessionId, participant.participantToken, "Still too late")
      ).rejects.toBeInstanceOf(PromptNotActiveError);
    });
  });
});
