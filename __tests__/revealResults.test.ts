import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { submitResponse } from "../lib/session/submitResponse";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { completeSession } from "../lib/session/completeSession";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  SubmissionsNotClosedError,
} from "../lib/session/types";

async function setupClosedSession(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  const jordan = await joinSession(repo, session.roomCode, "Jordan");
  await lockLobby(repo, session.sessionId, session.hostToken);
  const interaction = await startSession(repo, session.sessionId, session.hostToken, {
    engineType: "OPEN_RESPONSE",
    promptText: "Prompt text",
  });
  await submitResponse(repo, session.sessionId, alex.participantToken, "Alex's answer");
  await submitResponse(repo, session.sessionId, jordan.participantToken, "Jordan's answer");
  await closeSubmissions(repo, session.sessionId, session.hostToken);
  return { session, alex, jordan, interaction };
}

describe("REVEAL_RESULTS", () => {
  it("transitions the current interaction instance from SUBMISSIONS_CLOSED to RESULT_REVEAL", async () => {
    const repo = new InMemorySessionRepository();
    const { session, interaction } = await setupClosedSession(repo);

    const result = await revealResults(repo, session.sessionId, session.hostToken);

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.interactionInstanceId).toBe(interaction.interactionInstanceId);
    expect(result.state).toBe("RESULT_REVEAL");
  });

  it("does not change the session's own state or state_version", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupClosedSession(repo);

    await revealResults(repo, session.sessionId, session.hostToken);

    const stored = await repo.getSessionById(session.sessionId);
    expect(stored?.state).toBe("LOBBY_LOCKED");
    expect(stored?.stateVersion).toBe(2); // create(1) -> lock(2), unchanged thereafter
  });

  it("rejects revealing before submissions are closed (PROMPT_ACTIVE)", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt text",
    });

    await expect(
      revealResults(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(SubmissionsNotClosedError);
  });

  it("rejects a mismatched host token", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupClosedSession(repo);

    await expect(
      revealResults(repo, session.sessionId, "wrong-token")
    ).rejects.toBeInstanceOf(HostTokenMismatchError);
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      revealResults(repo, "11111111-1111-1111-1111-111111111111", "any-token")
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("GET_SESSION exposes all submitted responses attributed to display names once revealed", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan } = await setupClosedSession(repo);
    await revealResults(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, session.hostToken);

    expect(result.interactionState).toBe("RESULT_REVEAL");
    expect(result.submissions).toEqual(
      expect.arrayContaining([
        {
          participantId: alex.participantId,
          displayName: "Alex",
          text: "Alex's answer",
          isCorrect: null,
        },
        {
          participantId: jordan.participantId,
          displayName: "Jordan",
          text: "Jordan's answer",
          isCorrect: null,
        },
      ])
    );
  });

  it("a participant can also read results once revealed", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupClosedSession(repo);
    await revealResults(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, alex.participantToken);

    expect(result.submissions).not.toBeNull();
    expect(result.submissions).toHaveLength(2);
  });

  it("full loop: create -> join -> lock -> start -> submit -> close -> reveal -> complete", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan } = await setupClosedSession(repo);
    await revealResults(repo, session.sessionId, session.hostToken);
    const completed = await completeSession(repo, session.sessionId, session.hostToken);

    expect(completed.state).toBe("SESSION_COMPLETE");

    const finalGet = await getSession(repo, session.sessionId, session.hostToken);
    expect(finalGet.state).toBe("SESSION_COMPLETE");
    expect(finalGet.participants).toHaveLength(2);
    // Documented, deliberate simplification: submissions are not shown
    // after SESSION_COMPLETE, unlike currentPrompt — see getSession.ts.
    expect(finalGet.submissions).toBeNull();
    void alex;
    void jordan;
  });

  describe("repository-level authority", () => {
    it("in-memory proof: concurrent reveal attempts yield exactly one success", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupClosedSession(repo);

      const attempts = await Promise.allSettled([
        revealResults(repo, session.sessionId, session.hostToken),
        revealResults(repo, session.sessionId, session.hostToken),
      ]);

      expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("sequential interactions (the motivating capability this slice adds)", () => {
    it("full two-interaction loop within one session: start -> submit -> close -> reveal, twice", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, jordan } = await setupClosedSession(repo);
      const firstReveal = await revealResults(repo, session.sessionId, session.hostToken);
      expect(firstReveal.state).toBe("RESULT_REVEAL");

      const second = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      });
      await submitResponse(repo, session.sessionId, alex.participantToken, "Alex round 2");
      await submitResponse(repo, session.sessionId, jordan.participantToken, "Jordan round 2");
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      const secondReveal = await revealResults(repo, session.sessionId, session.hostToken);

      expect(secondReveal.interactionInstanceId).toBe(second.interactionInstanceId);
      expect(secondReveal.state).toBe("RESULT_REVEAL");

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.interactionNumber).toBe(2);
      expect(result.submissions).toEqual(
        expect.arrayContaining([
          {
            participantId: alex.participantId,
            displayName: "Alex",
            text: "Alex round 2",
            isCorrect: null,
          },
          {
            participantId: jordan.participantId,
            displayName: "Jordan",
            text: "Jordan round 2",
            isCorrect: null,
          },
        ])
      );

      const instances = repo._allInteractionInstances();
      expect(instances).toHaveLength(2);
      expect(instances.every((i) => i.state === "RESULT_REVEAL")).toBe(true);
    });
  });
});
