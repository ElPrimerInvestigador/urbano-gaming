-- Migration: 0036_add_segment_id_to_interaction_instances
-- Slice 008 — Segment / Turn grouping.
--
-- Attaches every interaction_instances row to a Segment. Every
-- pre-Slice-008 row predates the Segment concept entirely, so unlike
-- 0023's engine_type addition (a single static default correctly
-- backfills every existing row), each existing Interaction Instance
-- here needs its own, distinct new Segment — "one historical Interaction
-- Instance -> one historical Segment," the accepted backward-
-- compatibility mapping. A single INSERT...SELECT cannot both create
-- those rows and write each one's generated id back to the correct
-- source row without a fragile timestamp correlation, so this uses the
-- standard, well-understood PL/pgSQL "insert one, capture its id,
-- update the source row" loop instead, correlated by
-- interaction_instance_id (the real primary key), not by created_at.
--
-- Per-session segment_ordinal is assigned by row_number() over
-- (session_id, created_at, interaction_instance_id) — created_at is the
-- best available historical chronology; interaction_instance_id is only
-- a deterministic tie-break for the (expected to be rare, unverified
-- either way) case of two historical rows sharing an identical
-- created_at. This tie-break can reorder such a pair arbitrarily
-- relative to their true real-world order, which can no longer be
-- proven from stored data alone — an acceptable limitation for
-- one-time historical reconstruction, not a standard this migration
-- imposes on any future Segment (see 0037: every new segment_ordinal is
-- allocated atomically, under a real lock, with no timestamp involved
-- in its ordering at all).
--
-- At this application's current production scale (a handful of
-- playtest sessions), a per-row loop is safe and fast; interaction_instances
-- is explicitly not a high-volume table.

alter table interaction_instances add column if not exists segment_id uuid;

do $$
declare
  r record;
  new_segment_id uuid;
begin
  for r in
    select
      interaction_instance_id,
      session_id,
      created_at,
      row_number() over (
        partition by session_id
        order by created_at, interaction_instance_id
      ) as historical_ordinal
    from interaction_instances
    where segment_id is null
    order by session_id, historical_ordinal
  loop
    insert into segments (session_id, segment_ordinal, created_at)
    values (r.session_id, r.historical_ordinal, r.created_at)
    returning segment_id into new_segment_id;

    update interaction_instances
    set segment_id = new_segment_id
    where interaction_instance_id = r.interaction_instance_id;
  end loop;
end $$;

-- Every row must now have a segment_id — fails loudly if the backfill
-- above missed any row, rather than silently allowing a null through.
alter table interaction_instances alter column segment_id set not null;

-- The composite FK is the actual integrity guarantee this slice adds:
-- interaction_instances.session_id and .segment_id must jointly match a
-- real segments row, making cross-session Segment membership
-- structurally impossible — a single-column FK on segment_id alone
-- could not prevent session_id and segment_id disagreeing about which
-- session an Interaction Instance belongs to.
alter table interaction_instances
  add constraint interaction_instances_session_segment_fkey
  foreign key (session_id, segment_id) references segments (session_id, segment_id);

-- PostgreSQL does not automatically index a foreign key's referencing
-- columns (only the referenced side gets one, via segments' own UNIQUE
-- constraints). Without this, every check of "does any Interaction
-- Instance still reference this Segment" — which Postgres performs
-- whenever a segments row is touched, including as part of a session's
-- cascade delete — would require a full sequential scan of
-- interaction_instances. Verified locally: this migration rehearsal's
-- session-delete cascade test passed even without this index at this
-- table's current (tiny) local size, which is exactly why the gap was
-- easy to miss — it is a real, standard latent cost, not a
-- hypothetical one, and cheap to close now.
create index if not exists interaction_instances_segment_id_idx
  on interaction_instances (segment_id);
