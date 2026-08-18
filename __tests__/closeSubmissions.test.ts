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
  HostTokenMismatchError,
  PromptNotActiveError,
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

describe("CLOSE_SUBMISSIONS", () => {
  it("transitions the current interaction instance from PROMPT_ACTIVE to SUBMISSIONS_CLOSED", async () => {
    const repo = new InMemorySessionRepository();
    const { session, interaction } = await setupActiveSession(repo);

    const result = await closeSubmissions(repo, session.sessionId, session.hostToken);

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.interactionInstanceId).toBe(interaction.interactionInstanceId);
    expect(result.state).toBe("SUBMISSIONS_CLOSED");
  });

  it("does not change the session's own state or state_version", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupActiveSession(repo);

    await closeSubmissions(repo, session.sessionId, session.hostToken);

    const stored = await repo.getSessionById(session.sessionId);
    expect(stored?.state).toBe("LOBBY_LOCKED");
    expect(stored?.stateVersion).toBe(2); // create(1) -> lock(2), unchanged by start/close
  });

  it("rejects closing before any interaction has started (LOBBY_LOCKED)", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      closeSubmissions(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(PromptNotActiveError);
  });

  it("rejects closing submissions twice", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupActiveSession(repo);
    await closeSubmissions(repo, session.sessionId, session.hostToken);

    await expect(
      closeSubmissions(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(PromptNotActiveError);
  });

  it("rejects a mismatched host token", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupActiveSession(repo);

    await expect(
      closeSubmissions(repo, session.sessionId, "wrong-token")
    ).rejects.toBeInstanceOf(HostTokenMismatchError);
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      closeSubmissions(repo, "11111111-1111-1111-1111-111111111111", "any-token")
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("submitted responses remain hidden but counted after closing", async () => {
    const repo = new InMemorySessionRepository();
    const { session, participant } = await setupActiveSession(repo);
    await submitResponse(repo, session.sessionId, participant.participantToken, "My answer");
    await closeSubmissions(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, session.hostToken);

    expect(result.interactionState).toBe("SUBMISSIONS_CLOSED");
    expect(result.submittedCount).toBe(1);
    expect(result.submissions).toBeNull();
    expect(JSON.stringify(result)).not.toContain("My answer");
  });

  it("rejects a new submission after submissions are closed", async () => {
    const repo = new InMemorySessionRepository();
    const { session, participant } = await setupActiveSession(repo);
    await closeSubmissions(repo, session.sessionId, session.hostToken);

    await expect(
      submitResponse(repo, session.sessionId, participant.participantToken, "Too late")
    ).rejects.toBeInstanceOf(PromptNotActiveError);
  });

  describe("repository-level authority", () => {
    it("in-memory proof: concurrent close attempts yield exactly one success", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupActiveSession(repo);

      const attempts = await Promise.allSettled([
        closeSubmissions(repo, session.sessionId, session.hostToken),
        closeSubmissions(repo, session.sessionId, session.hostToken),
      ]);

      expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("sequential interactions", () => {
    it("closes only the current interaction instance, leaving a prior revealed one untouched", async () => {
      const repo = new InMemorySessionRepository();
      const { session, interaction: firstInteraction } = await setupActiveSession(repo);
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      });

      await closeSubmissions(repo, session.sessionId, session.hostToken);

      const instances = repo._allInteractionInstances();
      const first = instances.find(
        (i) => i.interactionInstanceId === firstInteraction.interactionInstanceId
      );
      expect(first?.state).toBe("RESULT_REVEAL");
    });
  });
});
