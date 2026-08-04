-- Migration: 0028_add_predecessor_session_id_to_sessions
-- Session Continuity slice.
--
-- Models Session lineage (A -> B -> C -> ...) as a column on the NEW
-- session describing where it came from, rather than a column on the
-- OLD session pointing forward to what came later. This is the
-- accepted design decision: a SESSION_COMPLETE session has never been
-- written to again by any existing repository method (createSession,
-- lockLobby, and completeSession are the only writers of the sessions
-- table, and none of them touch an already-complete row) — a forward
-- "successor_session_id" column would have required the first-ever
-- mutation of a terminal session row. predecessor_session_id instead
-- fits directly into the existing createSession(record, initialEvent)
-- shape: one more field on a row being freshly inserted, no different
-- in kind from room_code or host_token.
--
-- Nullable: most sessions have no predecessor. Self-referencing FK to
-- sessions(session_id) — no ON DELETE behavior needed since no
-- repository method ever deletes a session row.
--
-- Unique: "a Session can only have one direct successor" is enforced
-- as a plain unique index. Postgres unique indexes treat NULL values
-- as distinct from one another, so any number of sessions may share
-- predecessor_session_id = null; only a genuine second session naming
-- the same non-null predecessor collides. This is deliberately a
-- single-predecessor/single-successor edge per session, not a
-- prohibition on chains — nothing here limits how many sessions deep
-- a lineage (A -> B -> C -> D) may go, since each link only ever
-- constrains its own immediate predecessor.
--
-- Self-reference check: a session cannot be its own predecessor. Not
-- reachable through any current code path (the predecessor must exist
-- and be SESSION_COMPLETE before this session is even created), but
-- cheap, permanent insurance at the schema level.

alter table sessions
  add column predecessor_session_id uuid null references sessions (session_id);

alter table sessions
  add constraint sessions_predecessor_not_self
  check (predecessor_session_id is null or predecessor_session_id <> session_id);

create unique index if not exists sessions_predecessor_session_id_unique
  on sessions (predecessor_session_id);
