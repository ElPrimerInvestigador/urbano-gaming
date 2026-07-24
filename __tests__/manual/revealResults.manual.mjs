// Fallback validation harness for REVEAL_RESULTS. Mirrors
// startSession.manual.mjs's rationale.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession";
import { joinSession } from "../../lib/session/joinSession";
import { lockLobby } from "../../lib/session/lockLobby";
import { startSession } from "../../lib/session/startSession";
import { submitResponse } from "../../lib/session/submitResponse";
import { closeSubmissions } from "../../lib/session/closeSubmissions";
import { revealResults } from "../../lib/session/revealResults";
import { getSession } from "../../lib/session/getSession";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository";

test("the host can reveal results after closing submissions", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const alex = await joinSession(repo, session.roomCode, "Alex");
  await lockLobby(repo, session.sessionId, session.hostToken);
  await startSession(repo, session.sessionId, session.hostToken);
  await submitResponse(repo, session.sessionId, alex.participantToken, "My answer");
  await closeSubmissions(repo, session.sessionId, session.hostToken);
  const result = await revealResults(repo, session.sessionId, session.hostToken);
  assert.equal(result.state, "RESULT_REVEAL");

  const get = await getSession(repo, session.sessionId, session.hostToken);
  assert.equal(get.submissions.length, 1);
  assert.equal(get.submissions[0].text, "My answer");
});

test("rejects revealing before submissions are closed", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await lockLobby(repo, session.sessionId, session.hostToken);
  await startSession(repo, session.sessionId, session.hostToken);
  await assert.rejects(() => revealResults(repo, session.sessionId, session.hostToken));
});
