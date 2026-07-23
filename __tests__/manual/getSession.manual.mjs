// Fallback validation harness for GET_SESSION against the reconciled
// canonical interface. Mirrors lockLobby.manual.mjs's rationale:
// exercises the real source modules via Node's built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../../lib/session/createSession";
import { joinSession } from "../../lib/session/joinSession";
import { getSession } from "../../lib/session/getSession";
import { InMemorySessionRepository } from "../../lib/session/db/inMemorySessionRepository";

test("the host can read session state and participant list", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const participant = await joinSession(repo, session.roomCode, "Alex");

  const result = await getSession(repo, session.sessionId, session.hostToken);

  assert.equal(result.state, "LOBBY_OPEN");
  assert.equal(result.stateVersion, 1);
  assert.deepEqual(result.participants, [
    { participantId: participant.participantId, displayName: "Alex" },
  ]);
});

test("a participant can read the session using their own token", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  const participant = await joinSession(repo, session.roomCode, "Jordan");

  const result = await getSession(
    repo,
    session.sessionId,
    participant.participantToken
  );
  assert.equal(result.sessionId, session.sessionId);
});

test("rejects an unrelated token", async () => {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await assert.rejects(() => getSession(repo, session.sessionId, "wrong-token"));
});

test("rejects a nonexistent session id", async () => {
  const repo = new InMemorySessionRepository();
  await assert.rejects(() =>
    getSession(repo, "11111111-1111-1111-1111-111111111111", "any-token")
  );
});
