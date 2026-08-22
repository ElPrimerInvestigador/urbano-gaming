import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { submitResponse } from "../lib/session/submitResponse";
import { castVote } from "../lib/session/castVote";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  InvalidVotingCandidatesError,
  SelfVoteNotAllowedError,
} from "../lib/session/types";

/**
 * Slice 009 (Engine Selection + PARTICIPANTS Voting).
 *
 * Covers the two capabilities this slice actually adds beyond Slice
 * 007/008's existing Voting/Segment behavior (both of which stay
 * covered, unchanged in intent, by voting.test.ts and segment.test.ts):
 *
 *   - VotingCandidateSource "PARTICIPANTS" — the session's own roster
 *     becomes the Candidate list, one Candidate per participant.
 *   - Structured Candidate attribution (voting_candidates.participant_id,
 *     mirrored here by InMemorySessionRepository) and the self-vote
 *     prohibition it makes possible.
 *
 * Does not re-prove anything HOST_AUTHORED/SUBMISSION already cover
 * (prompt validation, ambiguity, segment target orthogonality in
 * general) except where PARTICIPANTS' own behavior could plausibly
 * diverge from that precedent.
 */

async function setupLockedSession(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  const jordan = await joinSession(repo, session.roomCode, "Jordan");
  const sam = await joinSession(repo, session.roomCode, "Sam");
  await lockLobby(repo, session.sessionId, session.hostToken);
  return { session, alex, jordan, sam };
}

function startParticipantsVoting(
  repo: InMemorySessionRepository,
  session: { sessionId: string; hostToken: string },
  promptText = "Vote for your favorite person!"
) {
  return startSession(repo, session.sessionId, session.hostToken, {
    engineType: "VOTING",
    promptText,
    candidateSource: { type: "PARTICIPANTS" },
  });
}

describe("START_SESSION with a PARTICIPANTS votingCandidateSource", () => {
  it("snapshots one Candidate per current participant, labeled by display name", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, sam } = await setupLockedSession(repo);

    const started = await startParticipantsVoting(repo, session);
    expect(started.engineType).toBe("VOTING");

    const candidates = await repo.getVotingCandidatesForInteraction(
      started.interactionInstanceId
    );
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.label).sort()).toEqual(
      ["Alex", "Jordan", "Sam"].sort()
    );

    // Each Candidate is attributed to the participant it snapshots —
    // the structured attribution this slice adds (voting_candidates.
    // participant_id), not merely informal provenance.
    const byName = new Map(candidates.map((c) => [c.label, c]));
    expect(byName.get("Alex")?.participantId).toBe(alex.participantId);
    expect(byName.get("Jordan")?.participantId).toBe(jordan.participantId);
    expect(byName.get("Sam")?.participantId).toBe(sam.participantId);
  });

  it("orders Candidates by join order, mirroring SUBMISSION's stable created_at ordering precedent", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan, sam } = await setupLockedSession(repo);

    const started = await startParticipantsVoting(repo, session);
    const candidates = await repo.getVotingCandidatesForInteraction(
      started.interactionInstanceId
    );
    const byOrdinal = [...candidates].sort((a, b) => a.ordinal - b.ordinal);
    expect(byOrdinal.map((c) => c.label)).toEqual([
      alex.displayName,
      jordan.displayName,
      sam.displayName,
    ]);
  });

  it("rejects fewer than two participants — the same floor HOST_AUTHORED enforces, regardless of source", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await joinSession(repo, session.roomCode, "Alex");
    await lockLobby(repo, session.sessionId, session.hostToken);

    await expect(startParticipantsVoting(repo, session)).rejects.toBeInstanceOf(
      InvalidVotingCandidatesError
    );
  });

  describe("repository-level authority (closes the TOCTOU gap)", () => {
    it("in-memory proof: the PARTICIPANTS floor is independently enforced, even when called directly (bypassing the domain fast-path)", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await joinSession(repo, session.roomCode, "Alex");
      await lockLobby(repo, session.sessionId, session.hostToken);

      await expect(
        repo.startSession(session.sessionId, session.hostToken, {
          engineType: "VOTING",
          promptText: "Vote for your favorite!",
          candidateSource: { type: "PARTICIPANTS" },
        })
      ).rejects.toBeInstanceOf(InvalidVotingCandidatesError);
    });
  });

  it("is fully independent of Segment Target — PARTICIPANTS + NEW_SEGMENT (the default) allocates a new Turn", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);
    const first = await startParticipantsVoting(repo, session);

    expect(first.segmentNumber).toBe(1);
  });

  it("is fully independent of Segment Target — PARTICIPANTS + CURRENT_SEGMENT attaches to the existing Turn, exactly like SUBMISSION already can", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    const first = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Tell us your best joke!",
    });
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    const second = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      {
        engineType: "VOTING",
        promptText: "Now vote for a person instead!",
        candidateSource: { type: "PARTICIPANTS" },
      },
      "CURRENT_SEGMENT"
    );

    expect(second.segmentNumber).toBe(first.segmentNumber);
  });
});

describe("Candidate Source vs Segment Target orthogonality: SUBMISSION + NEW_SEGMENT", () => {
  it("is not rejected — the Best Joke proving case's CURRENT_SEGMENT pairing is a UI choice, not a domain requirement", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan } = await setupLockedSession(repo);

    const openResponse = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Tell us your best joke!",
    });
    await submitResponse(repo, session.sessionId, alex.participantToken, "Joke A");
    await submitResponse(repo, session.sessionId, jordan.participantToken, "Joke B");
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    // Deliberately omit segmentTarget (defaults to NEW_SEGMENT) while
    // still sourcing Candidates from the prior interaction's
    // submissions — proving these two dimensions are independent.
    const voting = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for the funniest!",
      candidateSource: { type: "SUBMISSION", sourceInteractionInstanceId: openResponse.interactionInstanceId },
    });

    expect(voting.engineType).toBe("VOTING");
    expect(voting.segmentNumber).toBe(2); // a new Turn, not a continuation of Turn 1
  });
});

describe("CAST_VOTE: self-vote prohibition (Slice 009)", () => {
  it("rejects a participant voting for their own PARTICIPANTS-sourced Candidate", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupLockedSession(repo);
    const interaction = await startParticipantsVoting(repo, session);
    const candidates = await repo.getVotingCandidatesForInteraction(
      interaction.interactionInstanceId
    );
    const ownCandidate = candidates.find((c) => c.participantId === alex.participantId)!;

    await expect(
      castVote(repo, session.sessionId, alex.participantToken, ownCandidate.candidateId)
    ).rejects.toBeInstanceOf(SelfVoteNotAllowedError);
  });

  it("rejects a participant voting for their own SUBMISSION-sourced Candidate", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan } = await setupLockedSession(repo);
    const openResponse = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Tell us your best joke!",
    });
    await submitResponse(repo, session.sessionId, alex.participantToken, "Alex's joke");
    await submitResponse(repo, session.sessionId, jordan.participantToken, "Jordan's joke");
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    const voting = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for the funniest!",
      candidateSource: { type: "SUBMISSION", sourceInteractionInstanceId: openResponse.interactionInstanceId },
    });
    const candidates = await repo.getVotingCandidatesForInteraction(voting.interactionInstanceId);
    const ownCandidate = candidates.find((c) => c.participantId === alex.participantId)!;

    await expect(
      castVote(repo, session.sessionId, alex.participantToken, ownCandidate.candidateId)
    ).rejects.toBeInstanceOf(SelfVoteNotAllowedError);
  });

  it("allows voting for a different participant's PARTICIPANTS-sourced Candidate", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, jordan } = await setupLockedSession(repo);
    const interaction = await startParticipantsVoting(repo, session);
    const candidates = await repo.getVotingCandidatesForInteraction(
      interaction.interactionInstanceId
    );
    const othersCandidate = candidates.find((c) => c.participantId === jordan.participantId)!;

    const result = await castVote(
      repo,
      session.sessionId,
      alex.participantToken,
      othersCandidate.candidateId
    );
    expect(result.candidateId).toBe(othersCandidate.candidateId);
  });

  it("is a no-op for HOST_AUTHORED Candidates — participant_id is always null, so no voter is ever blocked", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupLockedSession(repo);
    const interaction = await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite!",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos"] },
    });
    const candidates = await repo.getVotingCandidatesForInteraction(
      interaction.interactionInstanceId
    );
    expect(candidates.every((c) => c.participantId === null)).toBe(true);

    const result = await castVote(
      repo,
      session.sessionId,
      alex.participantToken,
      candidates[0].candidateId
    );
    expect(result.candidateId).toBe(candidates[0].candidateId);
  });

  describe("repository-level authority (closes the TOCTOU gap)", () => {
    it("in-memory proof: self-vote is independently rejected, even when called directly (bypassing the domain fast-path)", async () => {
      const repo = new InMemorySessionRepository();
      const { session, alex } = await setupLockedSession(repo);
      const interaction = await startParticipantsVoting(repo, session);
      const candidates = await repo.getVotingCandidatesForInteraction(
        interaction.interactionInstanceId
      );
      const ownCandidate = candidates.find((c) => c.participantId === alex.participantId)!;

      await expect(
        repo.castVote(
          session.sessionId,
          alex.participantId,
          alex.participantToken,
          ownCandidate.candidateId
        )
      ).rejects.toBeInstanceOf(SelfVoteNotAllowedError);
    });
  });
});

describe("Candidate attribution non-leakage (GET_SESSION)", () => {
  it("never projects participant_id — VotingCandidateSummary carries only candidateId/ordinal/label", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupLockedSession(repo);
    await startParticipantsVoting(repo, session);

    const hostView = await getSession(repo, session.sessionId, session.hostToken);
    const participantView = await getSession(repo, session.sessionId, alex.participantToken);

    for (const view of [hostView, participantView]) {
      expect(view.currentVotingCandidates).not.toBeNull();
      for (const candidate of view.currentVotingCandidates!) {
        expect(Object.keys(candidate).sort()).toEqual(["candidateId", "label", "ordinal"]);
      }
    }
  });
});
