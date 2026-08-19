-- Migration: 0046_add_gaming_member_id_to_participants
-- URBANO Gaming Identity Foundation.
--
-- Links a per-Session Participant to a persistent Gaming Member,
-- without Gaming Member ever replacing Participant as the identity
-- gameplay commands operate on. Nullable: a Guest participant (no
-- room-code-only join, no Auth) has gaming_member_id null, exactly as
-- before this migration — every existing Guest code path is
-- byte-identical, since this column is additive and defaults to null
-- on every existing row.
--
-- on delete set null (not cascade): mirrors 0038's own reasoning for
-- voting_candidates.participant_id — a Participant's existing row (and
-- anything already attributed to it: submissions, votes, point_awards)
-- must remain intact even if the Gaming Member it was once linked to
-- is later removed. Deleting a Gaming Member un-links its historical
-- Participant rows rather than deleting or orphaning them.
--
-- Indexed proactively (participants_gaming_member_id_idx): Postgres
-- never automatically indexes a foreign key's referencing side — the
-- same lesson already recorded against segments/interaction_instances
-- and voting_candidates.participant_id — and this column's own
-- on delete set null action requires this index to avoid a full table
-- scan of participants on every Gaming Member delete.
--
-- One-Gaming-Member-per-Session enforcement
-- (participants_session_gaming_member_unique): a partial unique index
-- over (session_id, gaming_member_id) WHERE gaming_member_id IS NOT
-- NULL, directly reusing the NULL-distinctness technique already
-- proven in this codebase by
-- sessions_predecessor_session_id_unique (0028) — Postgres treats
-- every NULL as distinct from every other NULL in a unique index, so
-- any number of Guest participants (gaming_member_id null) coexist
-- freely, while a second Participant naming the same
-- (session_id, gaming_member_id) pair collides. The same authenticated
-- Gaming Member may still join a different Session freely, since
-- session_id differs.
--
-- participants_session_display_name_unique (0003) is untouched by this
-- migration — an authenticated member's display name still collides
-- with an existing Guest or member exactly as it always has, surfacing
-- the existing DisplayNameTakenError. This migration adds identity
-- linkage; it does not change display-name semantics.

alter table participants
  add column gaming_member_id uuid null
    references gaming_members (gaming_member_id) on delete set null;

create index if not exists participants_gaming_member_id_idx
  on participants (gaming_member_id);

create unique index if not exists participants_session_gaming_member_unique
  on participants (session_id, gaming_member_id)
  where gaming_member_id is not null;
