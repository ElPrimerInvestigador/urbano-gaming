import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { completeSession } from "../lib/session/completeSession";
import { createSuccessorSession } from "../lib/session/createSuccessorSession";
import { startSession } from "../lib/session/startSession";
import { submitResponse } from "../lib/session/submitResponse";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  PreviousInteractionNotRevealedError,
  NoCurrentSegmentToContinueError,
} from "../lib/session/types";

/**
 * Slice 008 — Segment / Turn grouping.
 *
 * Covers the founder-directed test plan: ordinal allocation (single and
 * sequential), CURRENT_SEGMENT composition (the Best Joke proving
 * case), the concurrency guarantee traced against the real
 * start_session_atomically SQL (see supabase/migrations/0037's
 * comment), GET_SESSION's segmentNumber projection, rematch isolation,
 * and STRANDED administrative completion. Database-level integrity
 * (the composite FK, the UNIQUE (session_id, segment_ordinal)
 * constraint, and live concurrency against real Postgres) is covered
 * separately in segmentSupabaseRepository.contract.test.ts — this
 * in-memory double cannot exercise real constraint enforcement.
 */
async function setupLockedSession(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  const jordan = await joinSession(repo, session.roomCode, "Jordan");
  await lockLobby(repo, session.sessionId, session.hostToken);
  return { session, alex, jordan };
}

describe("Slice 008 — Segment / Turn grouping", () => {
  it("the first Segment created for a session gets ordinal 1", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    const started = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Prompt 1" }
    );

    expect(started.segmentNumber).toBe(1);
    const segments = repo._allSegments();
    expect(segments).toHaveLength(1);
    expect(segments[0].segmentOrdinal).toBe(1);
  });

  it("a second NEW_SEGMENT call allocates ordinal 2", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt 1",
    });
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    const second = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Prompt 2" }
    );

    expect(second.segmentNumber).toBe(2);
    expect(repo._allSegments()).toHaveLength(2);
  });

  it("three or more NEW_SEGMENT calls allocate strictly increasing ordinals 1, 2, 3...", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    const first = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt 1",
    });
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    const second = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt 2",
    });
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    const third = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt 3",
    });

    expect([first.segmentNumber, second.segmentNumber, third.segmentNumber]).toEqual([1, 2, 3]);
  });

  it("CURRENT_SEGMENT attaches a second Interaction Instance to the same Segment, keeping ordinal 1", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupLockedSession(repo);

    const openResponse = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Tell us your best joke!" }
    );
    await submitResponse(
      repo,
      session.sessionId,
      alex.participantToken,
      "Why did the chicken cross the road?"
    );
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    const voting = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      {
        engineType: "VOTING",
        promptText: "Vote for the funniest!",
        candidateSource: {
          type: "SUBMISSION",
          sourceInteractionInstanceId: openResponse.interactionInstanceId,
        },
      },
      "CURRENT_SEGMENT"
    );

    expect(voting.segmentNumber).toBe(1);
    expect(openResponse.segmentNumber).toBe(1);
    expect(repo._allSegments()).toHaveLength(1);

    const instances = repo._allInteractionInstances();
    expect(instances).toHaveLength(2);
    expect(instances[0].segmentId).toBe(instances[1].segmentId);
  });

  it("concurrent NEW_SEGMENT calls: exactly one succeeds, the loser fails under the existing lifecycle guard, no duplicate ordinal is ever created", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

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
    const failures = attempts.filter(
      (a): a is PromiseRejectedResult => a.status === "rejected"
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBeInstanceOf(PreviousInteractionNotRevealedError);

    const segments = repo._allSegments();
    expect(segments).toHaveLength(1);
    const ordinals = segments.map((s) => s.segmentOrdinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it("rejects CURRENT_SEGMENT when no Segment has ever been created for this session", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    await expect(
      startSession(
        repo,
        session.sessionId,
        session.hostToken,
        {
          engineType: "VOTING",
          promptText: "Vote for the funniest!",
          candidateSource: { type: "HOST_AUTHORED", candidates: ["A", "B"] },
        },
        "CURRENT_SEGMENT"
      )
    ).rejects.toBeInstanceOf(NoCurrentSegmentToContinueError);

    expect(repo._allSegments()).toHaveLength(0);
  });

  it("CURRENT_SEGMENT still enforces the existing RESULT_REVEAL precondition", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt 1",
    });
    // Still PROMPT_ACTIVE — never closed or revealed.

    await expect(
      startSession(
        repo,
        session.sessionId,
        session.hostToken,
        {
          engineType: "VOTING",
          promptText: "Vote for the funniest!",
          candidateSource: { type: "HOST_AUTHORED", candidates: ["A", "B"] },
        },
        "CURRENT_SEGMENT"
      )
    ).rejects.toBeInstanceOf(PreviousInteractionNotRevealedError);
  });

  it("GET_SESSION's segmentNumber comes from the current Segment's ordinal, not from Interaction Instance count", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupLockedSession(repo);

    const openResponse = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Tell us your best joke!" }
    );
    await submitResponse(repo, session.sessionId, alex.participantToken, "Knock knock.");
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      {
        engineType: "VOTING",
        promptText: "Vote for the funniest!",
        candidateSource: {
          type: "SUBMISSION",
          sourceInteractionInstanceId: openResponse.interactionInstanceId,
        },
      },
      "CURRENT_SEGMENT"
    );

    const result = await getSession(repo, session.sessionId, session.hostToken);

    // interactionNumber counts both Interaction Instances (2); segmentNumber
    // stays 1, since both belong to the same Segment/Turn — this
    // divergence is the entire point of Slice 008.
    expect(result.interactionNumber).toBe(2);
    expect(result.segmentNumber).toBe(1);
  });

  describe("Best Joke proving case", () => {
    it("Open Response then Voting stay on Turn 1; a later standalone interaction moves to Turn 2", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex, jordan } = await setupLockedSession(repo);

      const openResponse = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        { engineType: "OPEN_RESPONSE", promptText: "Tell us your best joke!" }
      );
      expect(openResponse.segmentNumber).toBe(1);

      await submitResponse(
        repo,
        session.sessionId,
        alex.participantToken,
        "Why did the chicken cross the road?"
      );
      await submitResponse(repo, session.sessionId, jordan.participantToken, "Knock knock.");
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const voting = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        {
          engineType: "VOTING",
          promptText: "Vote for the funniest!",
          candidateSource: {
            type: "SUBMISSION",
            sourceInteractionInstanceId: openResponse.interactionInstanceId,
          },
        },
        "CURRENT_SEGMENT"
      );
      expect(voting.segmentNumber).toBe(1);
      expect(voting.interactionInstanceId).not.toBe(openResponse.interactionInstanceId);

      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      const nextTurn = await startSession(
        repo,
        session.sessionId,
        session.hostToken,
        { engineType: "OPEN_RESPONSE", promptText: "Next ad-hoc question" }
      );
      expect(nextTurn.segmentNumber).toBe(2);

      expect(repo._allSegments()).toHaveLength(2);
      expect(repo._allInteractionInstances()).toHaveLength(3);
    });
  });

  it("a rematch (successor session) starts with zero Segments; its first Segment is ordinal 1", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt 1",
    });
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);
    await completeSession(repo, session.sessionId, session.hostToken);

    const successor = await createSuccessorSession(
      repo,
      session.sessionId,
      session.hostToken
    );

    const segmentsBeforeStart = await repo.getSegmentsForSession(successor.sessionId);
    expect(segmentsBeforeStart).toHaveLength(0);

    await setSessionCapabilities(repo, successor.sessionId, successor.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await joinSession(repo, successor.roomCode, "Alex");
    await lockLobby(repo, successor.sessionId, successor.hostToken);
    const firstOfSuccessor = await startSession(
      repo,
      successor.sessionId,
      successor.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "New game, Prompt 1" }
    );

    expect(firstOfSuccessor.segmentNumber).toBe(1);
    // The predecessor's own Segment(s) are untouched and remain scoped
    // to it — rematch isolation by construction, not by a filter.
    const predecessorSegments = await repo.getSegmentsForSession(session.sessionId);
    expect(predecessorSegments).toHaveLength(1);
  });

  it("STRANDED: administrative Session completion while the current Interaction is PROMPT_ACTIVE remains valid, and segmentNumber stays correct", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    const started = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt 1",
    });
    expect(started.segmentNumber).toBe(1);

    // Interpretation 2 (administrative termination): completing while
    // PROMPT_ACTIVE is intentionally supported, unchanged by Slice 008 —
    // see completeSession.ts's own header comment.
    await completeSession(repo, session.sessionId, session.hostToken);

    const result = await getSession(repo, session.sessionId, session.hostToken);
    expect(result.state).toBe("SESSION_COMPLETE");
    expect(result.segmentNumber).toBe(1);
    expect(result.interactionState).toBe("PROMPT_ACTIVE");
  });
});
