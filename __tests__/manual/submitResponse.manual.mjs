// Fallback validation harness for SUBMIT_RESPONSE against the
// reconciled canonical interface. Mirrors startSession.manual.mjs's
// rationale: exercises the real source modules via Node's built-in
// test runner.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession";
import { joinSession } from "../../lib/session/joinSession";
import { lockLobby } from "../../lib/session/lockLobby";
import { startSession } from "../../lib/session/startSession";
import { submitResponse } from "../../lib/session/submitResponse";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository";

async function setupActiveSession(repo) {
  const session = await createSession(repo);
  const participant = await joinSession(repo, session.roomCode, "Alex");
  await lockLobby(repo, session.sessionId, session.hostToken);
  await startSession(repo, session.sessionId, session.hostToken);
  return { session, participant };
}

test("a participant can submit a response during PROMPT_ACTIVE", async () => {
  const repo = new InMemorySessionRepository();
  const { session, participant } = await setupActiveSession(repo);
  const result = await submitResponse(repo, session.sessionId, participant.participantToken, "Hello");
  assert.equal(result.text, "Hello");
});

test("last write wins on revision", async () => {
  const repo = new InMemorySessionRepository();
  const { session, participant } = await setupActiveSession(repo);
  await submitResponse(repo, session.sessionId, participant.participantToken, "First");
  const second = await submitResponse(repo, session.sessionId, participant.participantToken, "Second");
  assert.equal(second.text, "Second");
  const submissions = await repo.getSubmissionsForSession(session.sessionId);
  assert.equal(submissions.length, 1);
});

test("rejects a host token", async () => {
  const repo = new InMemorySessionRepository();
  const { session } = await setupActiveSession(repo);
  await assert.rejects(() => submitResponse(repo, session.sessionId, session.hostToken, "Hi"));
});

test("rejects an empty response", async () => {
  const repo = new InMemorySessionRepository();
  const { session, participant } = await setupActiveSession(repo);
  await assert.rejects(() => submitResponse(repo, session.sessionId, participant.participantToken, "  "));
});
