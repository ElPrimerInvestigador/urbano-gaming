-- Migration: 0035_create_segments
-- Slice 008 — Segment / Turn grouping.
--
-- A Segment groups one or more Interaction Instances under one stable,
-- member-facing Turn identity (the Best Joke proving case: an Open
-- Response phase followed by a Voting phase on the same Turn).
--
-- segment_ordinal IS the Turn number — a durable, database-allocated
-- value, not a derived count or an artifact of created_at ordering (see
-- 0037's migration comment for why: even with a real-time timestamp
-- function, a transaction's stored created_at can be captured before it
-- finishes waiting on a lock, so created_at alone cannot be trusted as
-- canonical order for a value this visible). created_at here is
-- audit/history information only.
--
-- Deliberately has no lifecycle/state column — whether a Segment is
-- still current, still accepting another Interaction Instance, or has
-- been superseded is entirely derived from its own most-recent
-- Interaction Instance's state and from whether a newer Segment exists,
-- mirroring interaction_instances' own "derive, don't persist"
-- precedent (0015) one level up. No Session.current_segment pointer and
-- no separate "next ordinal" counter, for the same reason.
--
-- UNIQUE (session_id, segment_id) exists purely so 0036 can add a
-- composite foreign key from interaction_instances(session_id,
-- segment_id) — segment_id is already globally unique via its primary
-- key, so this constraint costs nothing new to enforce; it exists to be
-- referenced, not to add a new invariant on this table itself.
--
-- UNIQUE (session_id, segment_ordinal) is the actual integrity
-- guarantee behind atomic ordinal allocation — see 0037.

create table if not exists segments (
  segment_id      uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions(session_id) on delete cascade,
  segment_ordinal integer not null,
  created_at      timestamptz not null default now(),
  constraint segments_session_id_segment_id_unique
    unique (session_id, segment_id),
  constraint segments_session_id_segment_ordinal_unique
    unique (session_id, segment_ordinal)
);
