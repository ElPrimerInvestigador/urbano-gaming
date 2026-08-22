import { randomUUID } from "crypto";
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
import { awardPoints } from "../lib/session/awardPoints";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  InteractionInstanceNotEligibleError,
  ParticipantNotInSessionError,
  InvalidPointsError,
} from "../lib/session/types";

async function setupRevealedSession(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  const jordan = await joinSession(repo, session.roomCode, "Jordan");
  await lockLobby(repo, session.sessionId, session.hostToken);
  const interaction = await startSession(repo, session.sessionId, session.hostToken, {
    engineType: "OPEN_RESPONSE",
    promptText: "Prompt text",
  });
  await submitResponse(repo, session.sessionId, alex.participantToken, "Alex answer");
  await submitResponse(repo, session.sessionId, jordan.participantToken, "Jordan answer");
  await closeSubmissions(repo, session.sessionId, session.hostToken);
  await revealResults(repo, session.sessionId, session.hostToken);
  return { session, alex, jordan, interaction };
}

describe("AWARD_POINTS", () => {
  it("awards points to a participant for the current, revealed interaction", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, interaction } = await setupRevealedSession(repo);

    const result = await awardPoints(
      repo,
      session.sessionId,
      session.hostToken,
      interaction.interactionInstanceId,
      alex.participantId,
      10,
      randomUUID()
    );

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.interactionInstanceId).toBe(interaction.interactionInstanceId);
    expect(result.participantId).toBe(alex.participantId);
    expect(result.points).toBe(10);
    expect(result.pointAwardId).toBeTruthy();
  });

  it("allows multiple independent awards for the same participant and interaction — no uniqueness rule", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, interaction } = await setupRevealedSession(repo);

    const first = await awardPoints(
      repo,
      session.sessionId,
      session.hostToken,
      interaction.interactionInstanceId,
      alex.participantId,
      10,
      randomUUID()
    );
    const second = await awardPoints(
      repo,
      session.sessionId,
      session.hostToken,
      interaction.interactionInstanceId,
      alex.participantId,
      5,
      randomUUID()
    );

    expect(second.pointAwardId).not.toBe(first.pointAwardId);
    expect(repo._allPointAwards()).toHaveLength(2);

    const result = await getSession(repo, session.sessionId, session.hostToken);
    const alexStanding = result.standings.find((s) => s.participantId === alex.participantId);
    expect(alexStanding?.score).toBe(15);
  });

  describe("idempotent replay", () => {
    it("returns the original result for a repeated idempotency key, same interaction still current", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);
      const idempotencyKey = randomUUID();

      const first = await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        idempotencyKey
      );
      const replay = await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        idempotencyKey
      );

      expect(replay).toEqual(first);
      expect(repo._allPointAwards()).toHaveLength(1);
    });

    it("returns the original result even after the session has progressed to a new interaction", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);
      const idempotencyKey = randomUUID();

      const first = await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        idempotencyKey
      );

      // Session moves on: a second interaction begins and is revealed.
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      });

      const replay = await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        idempotencyKey
      );

      expect(replay).toEqual(first);
      expect(repo._allPointAwards()).toHaveLength(1);
    });

    it("returns the original result even after the session has completed", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);
      const idempotencyKey = randomUUID();

      const first = await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        idempotencyKey
      );

      await completeSession(repo, session.sessionId, session.hostToken);

      const replay = await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        idempotencyKey
      );

      expect(replay).toEqual(first);
      expect(repo._allPointAwards()).toHaveLength(1);
    });

    it("does not require a valid host token, session state, interaction, participant, or points on replay — only the idempotency key needs to match", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);
      const idempotencyKey = randomUUID();

      const first = await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        idempotencyKey
      );

      // Every other argument is now "wrong" — a replay should still
      // succeed and return the original result, since only the
      // (sessionId, idempotencyKey) pair is consulted.
      const replay = await awardPoints(
        repo,
        session.sessionId,
        "wrong-host-token",
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
        -999,
        idempotencyKey
      );

      expect(replay).toEqual(first);
    });
  });

  describe("interaction eligibility (new awards only)", () => {
    it("rejects a new award for an interaction that is not the session's current one", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction: firstInteraction } = await setupRevealedSession(repo);
      const secondInteraction = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      });

      await expect(
        awardPoints(
          repo,
          session.sessionId,
          session.hostToken,
          firstInteraction.interactionInstanceId,
          alex.participantId,
          10,
          randomUUID()
        )
      ).rejects.toBeInstanceOf(InteractionInstanceNotEligibleError);

      void secondInteraction;
    });

    it("rejects a new award while the current interaction is still PROMPT_ACTIVE", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      const alex = await joinSession(repo, session.roomCode, "Alex");
      await lockLobby(repo, session.sessionId, session.hostToken);
      const interaction = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt text",
      });

      await expect(
        awardPoints(
          repo,
          session.sessionId,
          session.hostToken,
          interaction.interactionInstanceId,
          alex.participantId,
          10,
          randomUUID()
        )
      ).rejects.toBeInstanceOf(InteractionInstanceNotEligibleError);
    });

    it("rejects a new award while the current interaction is SUBMISSIONS_CLOSED", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      const alex = await joinSession(repo, session.roomCode, "Alex");
      await lockLobby(repo, session.sessionId, session.hostToken);
      const interaction = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt text",
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);

      await expect(
        awardPoints(
          repo,
          session.sessionId,
          session.hostToken,
          interaction.interactionInstanceId,
          alex.participantId,
          10,
          randomUUID()
        )
      ).rejects.toBeInstanceOf(InteractionInstanceNotEligibleError);
    });
  });

  it("rejects a new award once the session has completed", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, interaction } = await setupRevealedSession(repo);
    await completeSession(repo, session.sessionId, session.hostToken);

    await expect(
      awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        randomUUID()
      )
    ).rejects.toBeInstanceOf(LobbyNotLockedError);
  });

  it("rejects a mismatched host token on a new award", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, interaction } = await setupRevealedSession(repo);

    await expect(
      awardPoints(
        repo,
        session.sessionId,
        "wrong-token",
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        randomUUID()
      )
    ).rejects.toBeInstanceOf(HostTokenMismatchError);
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      awardPoints(
        repo,
        "11111111-1111-1111-1111-111111111111",
        "any-token",
        "22222222-2222-2222-2222-222222222222",
        "33333333-3333-3333-3333-333333333333",
        10,
        randomUUID()
      )
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("rejects a participant who does not belong to this session", async () => {
    const repo = new InMemorySessionRepository();
    const { session, interaction } = await setupRevealedSession(repo);
    const otherSession = await createSession(repo);
    await setSessionCapabilities(repo, otherSession.sessionId, otherSession.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    const outsider = await joinSession(repo, otherSession.roomCode, "Outsider");

    await expect(
      awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        outsider.participantId,
        10,
        randomUUID()
      )
    ).rejects.toBeInstanceOf(ParticipantNotInSessionError);
  });

  describe("points validation (new awards only)", () => {
    it("rejects zero points", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);

      await expect(
        awardPoints(
          repo,
          session.sessionId,
          session.hostToken,
          interaction.interactionInstanceId,
          alex.participantId,
          0,
          randomUUID()
        )
      ).rejects.toBeInstanceOf(InvalidPointsError);
    });

    it("rejects negative points", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);

      await expect(
        awardPoints(
          repo,
          session.sessionId,
          session.hostToken,
          interaction.interactionInstanceId,
          alex.participantId,
          -5,
          randomUUID()
        )
      ).rejects.toBeInstanceOf(InvalidPointsError);
    });

    it("rejects points exceeding the 10000 sanity bound", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);

      await expect(
        awardPoints(
          repo,
          session.sessionId,
          session.hostToken,
          interaction.interactionInstanceId,
          alex.participantId,
          10001,
          randomUUID()
        )
      ).rejects.toBeInstanceOf(InvalidPointsError);
    });

    it("accepts points at exactly the 10000 bound", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);

      const result = await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10000,
        randomUUID()
      );
      expect(result.points).toBe(10000);
    });
  });

  describe("repository-level authority", () => {
    it("in-memory proof: awardPoints independently rejects an ineligible interaction, even when called directly", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      const alex = await joinSession(repo, session.roomCode, "Alex");
      await lockLobby(repo, session.sessionId, session.hostToken);

      await expect(
        repo.awardPoints(
          session.sessionId,
          session.hostToken,
          "11111111-1111-1111-1111-111111111111",
          alex.participantId,
          10,
          randomUUID()
        )
      ).rejects.toBeInstanceOf(InteractionInstanceNotEligibleError);
    });

    it("in-memory proof: awardPoints independently rejects a mismatched host token, even when called directly", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);

      await expect(
        repo.awardPoints(
          session.sessionId,
          "wrong-token",
          interaction.interactionInstanceId,
          alex.participantId,
          10,
          randomUUID()
        )
      ).rejects.toBeInstanceOf(HostTokenMismatchError);
    });
  });

  describe("GET_SESSION integration", () => {
    it("standings default every participant to 0 before any award", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, jordan } = await setupRevealedSession(repo);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.standings).toEqual(
        expect.arrayContaining([
          { participantId: alex.participantId, displayName: "Alex", score: 0 },
          { participantId: jordan.participantId, displayName: "Jordan", score: 0 },
        ])
      );
    });

    it("standings accumulate across multiple interactions", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, jordan, interaction: firstInteraction } =
        await setupRevealedSession(repo);

      await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        firstInteraction.interactionInstanceId,
        alex.participantId,
        10,
        randomUUID()
      );
      await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        firstInteraction.interactionInstanceId,
        jordan.participantId,
        5,
        randomUUID()
      );

      const secondInteraction = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Second prompt",
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);
      await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        secondInteraction.interactionInstanceId,
        alex.participantId,
        7,
        randomUUID()
      );

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(
        result.standings.find((s) => s.participantId === alex.participantId)?.score
      ).toBe(17);
      expect(
        result.standings.find((s) => s.participantId === jordan.participantId)?.score
      ).toBe(5);
    });

    it("standings remain visible after SESSION_COMPLETE — final standings", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, interaction } = await setupRevealedSession(repo);
      await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        alex.participantId,
        10,
        randomUUID()
      );
      await completeSession(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.state).toBe("SESSION_COMPLETE");
      expect(
        result.standings.find((s) => s.participantId === alex.participantId)?.score
      ).toBe(10);
    });

    it("exposes currentInteractionInstanceId matching the current interaction", async () => {
      const repo = new InMemorySessionRepository();
      const { session, interaction } = await setupRevealedSession(repo);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.currentInteractionInstanceId).toBe(interaction.interactionInstanceId);
    });

    it("currentInteractionInstanceId is null before any interaction has started", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.currentInteractionInstanceId).toBeNull();
    });
  });
});
