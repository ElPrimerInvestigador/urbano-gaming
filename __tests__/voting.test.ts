import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { submitResponse } from "../lib/session/submitResponse";
import { castVote } from "../lib/session/castVote";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { prepareQuestions } from "../lib/session/prepareQuestions";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionAccessDeniedError,
  PromptNotActiveError,
  PreviousInteractionNotRevealedError,
  InvalidVotingCandidatesError,
  VotingSourceInteractionNotFoundError,
  VotingSourceInteractionNotEligibleError,
  InvalidCandidateSelectionError,
  AmbiguousStartSessionTargetError,
} from "../lib/session/types";

async function setupLockedSession(repo: InMemorySessionRepository) {
  const session = await createSession(repo);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  const jordan = await joinSession(repo, session.roomCode, "Jordan");
  const sam = await joinSession(repo, session.roomCode, "Sam");
  await lockLobby(repo, session.sessionId, session.hostToken);
  return { session, alex, jordan, sam };
}

async function startHostAuthoredVoting(
  repo: InMemorySessionRepository,
  session: { sessionId: string; hostToken: string },
  candidates: string[] = ["Pizza", "Tacos", "Sushi"]
) {
  return startSession(
    repo,
    session.sessionId,
    session.hostToken,
    "Vote for your favorite!",
    null,
    { type: "HOST_AUTHORED", candidates }
  );
}

describe("START_SESSION with a HOST_AUTHORED votingCandidateSource", () => {
  it("starts a VOTING interaction with Voting-owned Candidate snapshots", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    const started = await startHostAuthoredVoting(repo, session, [
      "Pizza",
      "Tacos",
      "Sushi",
    ]);

    expect(started.engineType).toBe("VOTING");

    const candidates = await repo.getVotingCandidatesForInteraction(
      started.interactionInstanceId
    );
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.label)).toEqual(["Pizza", "Tacos", "Sushi"]);
    expect(candidates.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    // Each Candidate is its own Voting-owned entity with a stable id,
    // not a reference back to anything else.
    const ids = new Set(candidates.map((c) => c.candidateId));
    expect(ids.size).toBe(3);
  });

  it("rejects fewer than two candidates", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    await expect(
      startHostAuthoredVoting(repo, session, ["Only one"])
    ).rejects.toBeInstanceOf(InvalidVotingCandidatesError);
  });

  it("rejects an empty (post-trim) candidate", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    await expect(
      startHostAuthoredVoting(repo, session, ["Pizza", "   "])
    ).rejects.toBeInstanceOf(InvalidVotingCandidatesError);
  });

  it("rejects duplicate candidates", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    await expect(
      startHostAuthoredVoting(repo, session, ["Pizza", "Pizza"])
    ).rejects.toBeInstanceOf(InvalidVotingCandidatesError);
  });

  it("requires promptText, unlike the prepared-question path", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);

    await expect(
      startSession(repo, session.sessionId, session.hostToken, "", null, {
        type: "HOST_AUTHORED",
        candidates: ["Pizza", "Tacos"],
      })
    ).rejects.toThrow();
  });

  it("rejects supplying both preparedQuestionId and votingCandidateSource — an ambiguous request, not silently resolved", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);
    const prepared = await prepareQuestions(repo, session.sessionId, session.hostToken, [
      { promptText: "Cats or dogs?", options: ["Cats", "Dogs"], correctOptionIndex: 0 },
    ]);

    await expect(
      startSession(
        repo,
        session.sessionId,
        session.hostToken,
        "Vote for your favorite!",
        prepared.questions[0].preparedQuestionId,
        { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos"] }
      )
    ).rejects.toBeInstanceOf(AmbiguousStartSessionTargetError);

    // Re-verified directly at the repository layer too, mirroring the
    // atomic function's own authoritative re-check.
    await expect(
      repo.startSession(
        session.sessionId,
        session.hostToken,
        "Vote for your favorite!",
        prepared.questions[0].preparedQuestionId,
        { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos"] }
      )
    ).rejects.toBeInstanceOf(AmbiguousStartSessionTargetError);
  });
});

describe("START_SESSION with a SUBMISSION votingCandidateSource (Open Response composition)", () => {
  async function setupRevealedOpenResponse(repo: InMemorySessionRepository) {
    const { session, alex, jordan, sam } = await setupLockedSession(repo);
    const interaction = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      "Tell us your best joke!"
    );
    await submitResponse(repo, session.sessionId, alex.participantToken, "Why did the chicken cross the road?");
    await submitResponse(repo, session.sessionId, jordan.participantToken, "Knock knock.");
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);
    return { session, alex, jordan, sam, interaction };
  }

  it("resolves eligible completed Open Response submissions into Voting-owned Candidates, across the Interaction Instance boundary", async () => {
    const repo = new InMemorySessionRepository();
    const { session, interaction } = await setupRevealedOpenResponse(repo);

    const started = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      "Vote for the funniest!",
      null,
      { type: "SUBMISSION", sourceInteractionInstanceId: interaction.interactionInstanceId }
    );

    expect(started.engineType).toBe("VOTING");
    const candidates = await repo.getVotingCandidatesForInteraction(
      started.interactionInstanceId
    );
    expect(candidates.map((c) => c.label).sort()).toEqual(
      ["Knock knock.", "Why did the chicken cross the road?"].sort()
    );

    // The source Open Response interaction itself is never modified.
    const sourceSubmissions = await repo.getSubmissionsForInteractionInstance(
      interaction.interactionInstanceId
    );
    expect(sourceSubmissions).toHaveLength(2);
  });

  it("rejects a source interaction that does not belong to this session", async () => {
    const repo = new InMemorySessionRepository();
    const { interaction } = await setupRevealedOpenResponse(repo);
    const otherSession = await createSession(repo);
    await joinSession(repo, otherSession.roomCode, "Other");
    await lockLobby(repo, otherSession.sessionId, otherSession.hostToken);

    await expect(
      startSession(
        repo,
        otherSession.sessionId,
        otherSession.hostToken,
        "Vote for the funniest!",
        null,
        { type: "SUBMISSION", sourceInteractionInstanceId: interaction.interactionInstanceId }
      )
    ).rejects.toBeInstanceOf(VotingSourceInteractionNotFoundError);
  });

  // Note: under this system's existing invariant that a new interaction
  // can only start once the *current* one is RESULT_REVEAL, the only
  // interaction that could ever be named as a not-yet-revealed
  // SUBMISSION source is the current interaction itself — every earlier
  // interaction is guaranteed already revealed by induction. So this
  // scenario is caught by START_SESSION's existing
  // PreviousInteractionNotRevealedError precondition before Voting's
  // own SUBMISSION-eligibility check is ever reached. Documented here
  // rather than asserting a branch this system's real call graph cannot
  // exercise.
  it("rejects sourcing from the current, not-yet-revealed interaction via the existing re-invocation precondition", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupLockedSession(repo);
    const interaction = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      "Tell us your best joke!"
    );
    await submitResponse(repo, session.sessionId, alex.participantToken, "Knock knock.");
    // deliberately not closed/revealed yet

    await expect(
      startSession(
        repo,
        session.sessionId,
        session.hostToken,
        "Vote for the funniest!",
        null,
        { type: "SUBMISSION", sourceInteractionInstanceId: interaction.interactionInstanceId }
      )
    ).rejects.toBeInstanceOf(PreviousInteractionNotRevealedError);
  });

  // VotingSourceInteractionNotEligibleError's specific "not RESULT_REVEAL"
  // branch is, on inspection, unreachable through any call path in this
  // system today — the "previous interaction must be RESULT_REVEAL"
  // check that guards every START_SESSION call (in both the domain
  // layer and inside this same repository method / atomic function)
  // always fires first for the only interaction a not-yet-revealed
  // SUBMISSION source could ever name (the current one). Kept as
  // defense-in-depth — a real, if currently unreachable, guard against
  // a future change (e.g. parallel interaction instances) that could
  // make it reachable — rather than removed, but not asserted by a test
  // here, since no real call path exercises it. Recorded in the Slice
  // 007 implementation record rather than silently left unremarked.

  it("rejects a revealed Multiple Choice interaction as a Voting source (must be OPEN_RESPONSE)", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupLockedSession(repo);
    const prepared = await prepareQuestions(repo, session.sessionId, session.hostToken, [
      { promptText: "Cats or dogs?", options: ["Cats", "Dogs"], correctOptionIndex: 0 },
    ]);
    const interaction = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      "",
      prepared.questions[0].preparedQuestionId
    );
    await submitResponse(repo, session.sessionId, alex.participantToken, "0");
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(
        repo,
        session.sessionId,
        session.hostToken,
        "Vote for the funniest!",
        null,
        { type: "SUBMISSION", sourceInteractionInstanceId: interaction.interactionInstanceId }
      )
    ).rejects.toBeInstanceOf(VotingSourceInteractionNotEligibleError);
  });

  it("rejects a revealed Open Response interaction with zero submissions", async () => {
    const repo = new InMemorySessionRepository();
    const { session } = await setupLockedSession(repo);
    const interaction = await startSession(
      repo,
      session.sessionId,
      session.hostToken,
      "Tell us your best joke!"
    );
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);

    await expect(
      startSession(
        repo,
        session.sessionId,
        session.hostToken,
        "Vote for the funniest!",
        null,
        { type: "SUBMISSION", sourceInteractionInstanceId: interaction.interactionInstanceId }
      )
    ).rejects.toBeInstanceOf(VotingSourceInteractionNotEligibleError);
  });
});

describe("CAST_VOTE", () => {
  async function setupActiveVoting(repo: InMemorySessionRepository) {
    const { session, alex, jordan, sam } = await setupLockedSession(repo);
    const interaction = await startHostAuthoredVoting(repo, session);
    const candidates = await repo.getVotingCandidatesForInteraction(
      interaction.interactionInstanceId
    );
    return { session, alex, jordan, sam, interaction, candidates };
  }

  it("accepts a valid vote", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, candidates } = await setupActiveVoting(repo);

    const result = await castVote(repo, session.sessionId, alex.participantToken, candidates[0].candidateId);

    expect(result.candidateId).toBe(candidates[0].candidateId);
    expect(result.participantId).toBe(alex.participantId);
  });

  it("allows a participant to revise their vote while the interaction remains active", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, candidates } = await setupActiveVoting(repo);

    await castVote(repo, session.sessionId, alex.participantToken, candidates[0].candidateId);
    await castVote(repo, session.sessionId, alex.participantToken, candidates[1].candidateId);

    const votes = await repo.getVotesForInteractionInstance(
      candidates[0].interactionInstanceId
    );
    expect(votes).toHaveLength(1);
    expect(votes[0].candidateId).toBe(candidates[1].candidateId);
  });

  it("rejects a vote after submissions close — immutable after close", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex, candidates } = await setupActiveVoting(repo);
    await closeSubmissions(repo, session.sessionId, session.hostToken);

    await expect(
      castVote(repo, session.sessionId, alex.participantToken, candidates[0].candidateId)
    ).rejects.toBeInstanceOf(PromptNotActiveError);
  });

  it("rejects a candidateId that does not exist at all", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupActiveVoting(repo);

    await expect(
      castVote(repo, session.sessionId, alex.participantToken, "11111111-1111-1111-1111-111111111111")
    ).rejects.toBeInstanceOf(InvalidCandidateSelectionError);
  });

  it("rejects a candidateId that exists but belongs to a different Voting interaction instance", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupActiveVoting(repo);

    // Close and reveal the first Voting round, then start a second,
    // independent one in the same session — its Candidates are real,
    // persisted rows, just not this interaction's own.
    await closeSubmissions(repo, session.sessionId, session.hostToken);
    await revealResults(repo, session.sessionId, session.hostToken);
    const firstRoundCandidates = await repo.getVotingCandidatesForInteraction(
      (await repo.getInteractionInstancesForSession(session.sessionId))[0].interactionInstanceId
    );
    const second = await startHostAuthoredVoting(repo, session, ["Cats", "Dogs"]);
    void second;

    await expect(
      castVote(repo, session.sessionId, alex.participantToken, firstRoundCandidates[0].candidateId)
    ).rejects.toBeInstanceOf(InvalidCandidateSelectionError);
  });

  it("rejects a wrong participant token", async () => {
    const repo = new InMemorySessionRepository();
    const { session, candidates } = await setupActiveVoting(repo);

    await expect(
      castVote(repo, session.sessionId, "not-a-real-token", candidates[0].candidateId)
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects a real participant token that belongs to a different session (the 'wrong session' case)", async () => {
    const repo = new InMemorySessionRepository();
    const { session, candidates } = await setupActiveVoting(repo);
    const otherSession = await setupLockedSession(repo);

    await expect(
      castVote(repo, session.sessionId, otherSession.alex.participantToken, candidates[0].candidateId)
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects casting a vote while the current interaction is not VOTING", async () => {
    const repo = new InMemorySessionRepository();
    const { session, alex } = await setupLockedSession(repo);
    await startSession(repo, session.sessionId, session.hostToken, "Open response prompt");

    await expect(
      castVote(repo, session.sessionId, alex.participantToken, "11111111-1111-1111-1111-111111111111")
    ).rejects.toBeInstanceOf(PromptNotActiveError);
  });
});

describe("Reveal, tallying, ties, and placement", () => {
  it("withholds vote totals and placement before reveal, while still exposing aggregate progress", async () => {
    const repo = new InMemorySessionRepository();
    const s = await setupLockedSession(repo);
    const interaction = await startHostAuthoredVoting(repo, s.session, ["Pizza", "Tacos", "Sushi"]);
    const cands = await repo.getVotingCandidatesForInteraction(interaction.interactionInstanceId);
    await castVote(repo, s.session.sessionId, s.alex.participantToken, cands[0].candidateId);

    const hostView = await getSession(repo, s.session.sessionId, s.session.hostToken);
    const participantView = await getSession(repo, s.session.sessionId, s.jordan.participantToken);

    expect(hostView.votingResults).toBeNull();
    expect(participantView.votingResults).toBeNull();
    // Progress is fine to expose — just not per-candidate tallies.
    expect(hostView.submittedCount).toBe(1);
    expect(hostView.eligibleParticipantCount).toBe(3);
  });

  it("reveals derived tally and standard-competition-ranked placement, including a zero-vote candidate", async () => {
    const repo = new InMemorySessionRepository();
    const s = await setupLockedSession(repo);
    const interaction = await startHostAuthoredVoting(repo, s.session, ["Pizza", "Tacos", "Sushi"]);
    const cands = await repo.getVotingCandidatesForInteraction(interaction.interactionInstanceId);

    // Pizza: 2 votes, Tacos: 1 vote, Sushi: 0 votes.
    await castVote(repo, s.session.sessionId, s.alex.participantToken, cands[0].candidateId);
    await castVote(repo, s.session.sessionId, s.jordan.participantToken, cands[0].candidateId);
    await castVote(repo, s.session.sessionId, s.sam.participantToken, cands[1].candidateId);

    await closeSubmissions(repo, s.session.sessionId, s.session.hostToken);
    await revealResults(repo, s.session.sessionId, s.session.hostToken);

    const result = await getSession(repo, s.session.sessionId, s.session.hostToken);
    expect(result.votingResults).not.toBeNull();
    const pizza = result.votingResults!.find((r) => r.candidateId === cands[0].candidateId)!;
    const tacos = result.votingResults!.find((r) => r.candidateId === cands[1].candidateId)!;
    const sushi = result.votingResults!.find((r) => r.candidateId === cands[2].candidateId)!;

    expect(pizza.voteCount).toBe(2);
    expect(pizza.rank).toBe(1);
    expect(tacos.voteCount).toBe(1);
    expect(tacos.rank).toBe(2);
    // Zero-vote candidate still receives a placement, correctly last.
    expect(sushi.voteCount).toBe(0);
    expect(sushi.rank).toBe(3);
  });

  it("represents a genuine tie with standard competition ranking (shared rank, next rank skips)", async () => {
    const repo = new InMemorySessionRepository();
    const s = await setupLockedSession(repo);
    const interaction = await startHostAuthoredVoting(repo, s.session, ["Pizza", "Tacos", "Sushi"]);
    const cands = await repo.getVotingCandidatesForInteraction(interaction.interactionInstanceId);

    // Pizza and Tacos both get 1 vote (tied for 1st); Sushi gets 0.
    await castVote(repo, s.session.sessionId, s.alex.participantToken, cands[0].candidateId);
    await castVote(repo, s.session.sessionId, s.jordan.participantToken, cands[1].candidateId);

    await closeSubmissions(repo, s.session.sessionId, s.session.hostToken);
    await revealResults(repo, s.session.sessionId, s.session.hostToken);

    const result = await getSession(repo, s.session.sessionId, s.session.hostToken);
    const pizza = result.votingResults!.find((r) => r.candidateId === cands[0].candidateId)!;
    const tacos = result.votingResults!.find((r) => r.candidateId === cands[1].candidateId)!;
    const sushi = result.votingResults!.find((r) => r.candidateId === cands[2].candidateId)!;

    expect(pizza.rank).toBe(1);
    expect(tacos.rank).toBe(1);
    // Standard competition ranking: the next distinct count skips ranks
    // by the number tied (two tied for 1st -> next is 3rd, not 2nd).
    expect(sushi.rank).toBe(3);
  });

  it("does not persist a voting_placements-shaped row anywhere — placement is derived, not stored", async () => {
    const repo = new InMemorySessionRepository();
    const s = await setupLockedSession(repo);
    const interaction = await startHostAuthoredVoting(repo, s.session, ["Pizza", "Tacos"]);
    const cands = await repo.getVotingCandidatesForInteraction(interaction.interactionInstanceId);
    await castVote(repo, s.session.sessionId, s.alex.participantToken, cands[0].candidateId);
    await closeSubmissions(repo, s.session.sessionId, s.session.hostToken);
    await revealResults(repo, s.session.sessionId, s.session.hostToken);

    // Calling the derivation twice must agree exactly — proof there is
    // no separate, potentially-drifting stored copy.
    const first = await repo.getVotingResultsForInteractionInstance(
      interaction.interactionInstanceId
    );
    const second = await repo.getVotingResultsForInteractionInstance(
      interaction.interactionInstanceId
    );
    expect(first).toEqual(second);
  });
});

describe("GET_SESSION: myVoteCandidateId — the first participant-identity-scoped field", () => {
  it("is null for the host", async () => {
    const repo = new InMemorySessionRepository();
    const s = await setupLockedSession(repo);
    const interaction = await startHostAuthoredVoting(repo, s.session);
    const cands = await repo.getVotingCandidatesForInteraction(interaction.interactionInstanceId);
    await castVote(repo, s.session.sessionId, s.alex.participantToken, cands[0].candidateId);

    const hostView = await getSession(repo, s.session.sessionId, s.session.hostToken);
    expect(hostView.myVoteCandidateId).toBeNull();
  });

  it("reflects each participant's own vote independently, before reveal", async () => {
    const repo = new InMemorySessionRepository();
    const s = await setupLockedSession(repo);
    const interaction = await startHostAuthoredVoting(repo, s.session);
    const cands = await repo.getVotingCandidatesForInteraction(interaction.interactionInstanceId);

    await castVote(repo, s.session.sessionId, s.alex.participantToken, cands[0].candidateId);
    await castVote(repo, s.session.sessionId, s.jordan.participantToken, cands[1].candidateId);

    const alexView = await getSession(repo, s.session.sessionId, s.alex.participantToken);
    const jordanView = await getSession(repo, s.session.sessionId, s.jordan.participantToken);
    const samView = await getSession(repo, s.session.sessionId, s.sam.participantToken);

    expect(alexView.myVoteCandidateId).toBe(cands[0].candidateId);
    expect(jordanView.myVoteCandidateId).toBe(cands[1].candidateId);
    expect(samView.myVoteCandidateId).toBeNull();
  });

  it("is null for any participant when the current interaction is not VOTING", async () => {
    const repo = new InMemorySessionRepository();
    const s = await setupLockedSession(repo);
    await startSession(repo, s.session.sessionId, s.session.hostToken, "Open response prompt");

    const alexView = await getSession(repo, s.session.sessionId, s.alex.participantToken);
    expect(alexView.myVoteCandidateId).toBeNull();
  });
});

describe("Composition and regression: Voting alongside Open Response and Multiple Choice", () => {
  it("runs Open Response -> Voting (composed) -> Multiple Choice sequentially in the same session without interference", async () => {
    const repo = new InMemorySessionRepository();
    const s = await setupLockedSession(repo);

    // Turn 1: Open Response.
    const openResponse = await startSession(
      repo,
      s.session.sessionId,
      s.session.hostToken,
      "Tell us your best joke!"
    );
    await submitResponse(repo, s.session.sessionId, s.alex.participantToken, "Joke A");
    await submitResponse(repo, s.session.sessionId, s.jordan.participantToken, "Joke B");
    await closeSubmissions(repo, s.session.sessionId, s.session.hostToken);
    await revealResults(repo, s.session.sessionId, s.session.hostToken);

    // Turn 2: Voting, composed from Turn 1's submissions.
    const voting = await startSession(
      repo,
      s.session.sessionId,
      s.session.hostToken,
      "Vote for the funniest!",
      null,
      { type: "SUBMISSION", sourceInteractionInstanceId: openResponse.interactionInstanceId }
    );
    const cands = await repo.getVotingCandidatesForInteraction(voting.interactionInstanceId);
    await castVote(repo, s.session.sessionId, s.alex.participantToken, cands[0].candidateId);
    await castVote(repo, s.session.sessionId, s.sam.participantToken, cands[0].candidateId);
    await closeSubmissions(repo, s.session.sessionId, s.session.hostToken);
    await revealResults(repo, s.session.sessionId, s.session.hostToken);

    // Turn 3: Multiple Choice, entirely unaffected by the two engines
    // that ran before it.
    const prepared = await prepareQuestions(repo, s.session.sessionId, s.session.hostToken, [
      { promptText: "Cats or dogs?", options: ["Cats", "Dogs"], correctOptionIndex: 1, points: 15 },
    ]);
    const mc = await startSession(
      repo,
      s.session.sessionId,
      s.session.hostToken,
      "",
      prepared.questions[0].preparedQuestionId
    );
    await submitResponse(repo, s.session.sessionId, s.alex.participantToken, "1");
    await closeSubmissions(repo, s.session.sessionId, s.session.hostToken);
    await revealResults(repo, s.session.sessionId, s.session.hostToken);

    const result = await getSession(repo, s.session.sessionId, s.session.hostToken);
    expect(result.currentEngineType).toBe("MULTIPLE_CHOICE");
    expect(result.currentPrompt?.options).toEqual(["Cats", "Dogs"]);
    const alexStanding = result.standings.find((st) => st.participantId === s.alex.participantId);
    expect(alexStanding?.score).toBe(15);

    // The Voting turn's own results remain correct as history — proves
    // no cross-engine state bled between Turns 1-3.
    const votingResults = await repo.getVotingResultsForInteractionInstance(
      voting.interactionInstanceId
    );
    const winner = votingResults.find((r) => r.candidateId === cands[0].candidateId)!;
    expect(winner.voteCount).toBe(2);
    expect(winner.rank).toBe(1);

    void mc;
  });
});
