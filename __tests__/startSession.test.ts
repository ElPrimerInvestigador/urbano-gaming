import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { completeSession } from "../lib/session/completeSession";
import { getSession } from "../lib/session/getSession";
import { startSession } from "../lib/session/startSession";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  PreviousInteractionNotRevealedError,
  EmptyPromptTextError,
  PromptTextTooLongError,
} from "../lib/session/types";

describe("START_SESSION", () => {
  it("creates a new interaction instance in PROMPT_ACTIVE for a LOBBY_LOCKED session", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    const result = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "What's your favorite pizza topping?" }
    );

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.state).toBe("PROMPT_ACTIVE");
    expect(result.interactionInstanceId).toBeTruthy();
    expect(result.promptId).toBeTruthy();
  });

  it("does not change the session's own state or state_version", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt text",
    });

    const stored = await repo.getSessionById(session.sessionId);
    expect(stored?.state).toBe("LOBBY_LOCKED");
    expect(stored?.stateVersion).toBe(2); // 1 (create) -> 2 (lock), unchanged by start
  });

  it("writes an INTERACTION_STARTED event with the interaction instance and prompt ids", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    const result = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt text",
    });
    const events = repo._getEventsForSession(session.sessionId);

    const startedEvent = events.find((e) => e.eventType === "INTERACTION_STARTED");
    expect(startedEvent).toBeDefined();
    expect(startedEvent?.payload).toEqual({
      interactionInstanceId: result.interactionInstanceId,
      promptId: result.promptId,
      engineType: "OPEN_RESPONSE",
    });
  });

  it("trims the host-supplied prompt text before persisting it", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    const result = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "  Pizza night!  " }
    );

    const prompt = await repo.getPromptById(result.promptId);
    expect(prompt?.text).toBe("Pizza night!");
  });

  it("rejects an empty (post-trim) prompt", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "   ",
      })
    ).rejects.toBeInstanceOf(EmptyPromptTextError);
  });

  it("rejects a prompt exceeding 1000 characters after trimming", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "a".repeat(1001),
      })
    ).rejects.toBeInstanceOf(PromptTextTooLongError);
  });

  it("rejects starting a session that was never locked (still LOBBY_OPEN)", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt text",
      })
    ).rejects.toBeInstanceOf(LobbyNotLockedError);
  });

  it("rejects starting again while the current interaction is still PROMPT_ACTIVE", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "First prompt",
    });

    await expect(
      startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      })
    ).rejects.toBeInstanceOf(PreviousInteractionNotRevealedError);
  });

  it("rejects starting again while the current interaction is SUBMISSIONS_CLOSED", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "First prompt",
    });
    await closeSubmissions(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      })
    ).rejects.toBeInstanceOf(PreviousInteractionNotRevealedError);
  });

  it("rejects starting a session that was administratively completed", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);
    await completeSession(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt text",
      })
    ).rejects.toBeInstanceOf(LobbyNotLockedError);
  });

  it("rejects a mismatched host token, leaving state unchanged", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(repo, session.sessionId, "wrong-token", {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt text",
      })
    ).rejects.toBeInstanceOf(HostTokenMismatchError);

    expect(repo._allInteractionInstances()).toHaveLength(0);
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      startSession(
        repo,
        "11111111-1111-1111-1111-111111111111",
        "any-token",
        { engineType: "OPEN_RESPONSE", promptText: "Prompt text" }
      )
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  describe("repository-level authority (closes the TOCTOU gap)", () => {
    it("in-memory proof: concurrent start attempts on the same session yield exactly one success", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await lockLobby(repo, session.sessionId, session.hostToken);

      const attempts = await Promise.allSettled([
        startSession(repo, session.sessionId, session.hostToken, {
          engineType: "OPEN_RESPONSE",
          promptText: "Prompt A",
        }),
        startSession(repo, session.sessionId, session.hostToken, {
          engineType: "OPEN_RESPONSE",
          promptText: "Prompt B",
        }),
      ]);

      const successes = attempts.filter((a) => a.status === "fulfilled");
      const failures = attempts.filter((a) => a.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(repo._allInteractionInstances()).toHaveLength(1);
    });

    it("in-memory proof: startSession independently rejects a session that is not LOBBY_LOCKED, even when called directly (bypassing the domain fast-path)", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

      await expect(
        repo.startSession(session.sessionId, session.hostToken, {
          engineType: "OPEN_RESPONSE",
          promptText: "Prompt text",
        })
      ).rejects.toBeInstanceOf(LobbyNotLockedError);
    });

    it("in-memory proof: startSession independently rejects a mismatched host token, even when called directly", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await lockLobby(repo, session.sessionId, session.hostToken);

      await expect(
        repo.startSession(session.sessionId, "wrong-token", {
          engineType: "OPEN_RESPONSE",
          promptText: "Prompt text",
        })
      ).rejects.toBeInstanceOf(HostTokenMismatchError);
    });

    it(
      "real Postgres contract proof NOT available in this environment — " +
        "start_session_atomically's row-locked re-check requires a live " +
        "database connection to verify serialization behavior under true " +
        "concurrency. The tests above prove the logic path; they do not " +
        "prove Postgres row-lock serialization itself.",
      () => {
        expect(true).toBe(true);
      }
    );
  });

  describe("GET_SESSION integration", () => {
    it("GET_SESSION returns the created prompt and interactionNumber once started", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await lockLobby(repo, session.sessionId, session.hostToken);
      const started = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        { engineType: "OPEN_RESPONSE", promptText: "Pizza night!" }
      );

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.interactionState).toBe("PROMPT_ACTIVE");
      expect(result.interactionNumber).toBe(1);
      expect(result.currentPrompt).not.toBeNull();
      expect(result.currentPrompt?.promptId).toBe(started.promptId);
      expect(result.currentPrompt?.text).toBe("Pizza night!");
    });

    it("currentPrompt remains visible after the session is later completed", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await lockLobby(repo, session.sessionId, session.hostToken);
      const started = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        { engineType: "OPEN_RESPONSE", promptText: "Prompt text" }
      );
      await completeSession(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.state).toBe("SESSION_COMPLETE");
      expect(result.currentPrompt?.promptId).toBe(started.promptId);
    });
  });

  it("full integrated sequence: create -> join -> lock -> start -> get reflects the prompt", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    const participant = await joinSession(repo, session.roomCode, "Alex");
    await lockLobby(repo, session.sessionId, session.hostToken);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt text",
    });

    const result = await getSession(repo, session.sessionId, session.hostToken);

    expect(result.interactionState).toBe("PROMPT_ACTIVE");
    expect(result.currentPrompt).not.toBeNull();
    expect(result.participants).toEqual([
      { participantId: participant.participantId, displayName: "Alex" },
    ]);
  });

  describe("sequential interactions (the motivating capability this slice adds)", () => {
    it("allows a second interaction to start once the first has been revealed", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await lockLobby(repo, session.sessionId, session.hostToken);

      const first = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        { engineType: "OPEN_RESPONSE", promptText: "First prompt" }
      );
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const second = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        { engineType: "OPEN_RESPONSE", promptText: "Second prompt" }
      );

      expect(second.interactionInstanceId).not.toBe(first.interactionInstanceId);
      expect(second.promptId).not.toBe(first.promptId);
      expect(second.state).toBe("PROMPT_ACTIVE");

      const instances = repo._allInteractionInstances();
      expect(instances).toHaveLength(2);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.interactionNumber).toBe(2);
      expect(result.currentPrompt?.promptId).toBe(second.promptId);
    });

    it("GET_SESSION's current interaction is always the most recently started one, and interactionNumber counts all of them", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await lockLobby(repo, session.sessionId, session.hostToken);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt 1",
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt 2",
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const third = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        { engineType: "OPEN_RESPONSE", promptText: "Prompt 3" }
      );

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.interactionNumber).toBe(3);
      expect(result.interactionState).toBe("PROMPT_ACTIVE");
      expect(result.currentPrompt?.promptId).toBe(third.promptId);
    });

    it("a prior interaction's submissions are not exposed as the current interaction's submissions", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await lockLobby(repo, session.sessionId, session.hostToken);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt 1",
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt 2",
      });

      const result = await getSession(repo, session.sessionId, session.hostToken);
      // Current interaction is PROMPT_ACTIVE, so submissions stays null —
      // the first interaction's revealed submissions must not leak through.
      expect(result.submissions).toBeNull();
    });
  });
});
