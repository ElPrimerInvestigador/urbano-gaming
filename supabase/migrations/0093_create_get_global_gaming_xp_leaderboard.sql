-- Migration: 0093_create_get_global_gaming_xp_leaderboard
-- Global Gaming XP Leaderboard — read-only projection of the Persistent
-- Metagame ledger established in Phase 1 (0085-0092).
--
-- This is the first read-only SQL function in this repository — every
-- prior SQL function in this codebase is a *_atomically write/mutation
-- function. That departure is deliberate and load-bearing, not
-- introduced for its own sake: PostgREST's configured max_rows (1000
-- locally; see supabase/config.toml) silently truncates any plain
-- unpaginated `.select()` once the row count exceeds it, with no
-- error — confirmed empirically against local Postgres during the
-- readiness gate (1500 gaming_xp_events rows for one member; a plain
-- `.select()` returned only 1000 rows, producing a naive SUM of 1000
-- against a true total of 1500). Every other read in this codebase is
-- naturally bounded (one Gaming Member's own rows, one Poker table's
-- seats); this is the first read whose row count scales with the
-- entire cross-member ledger, so it is the first read that needs the
-- aggregation performed inside Postgres itself rather than over
-- whatever a single HTTP response happened to return.
--
-- PostgREST's row cap was also empirically confirmed to apply to an
-- RPC function's own OUTPUT rows (tested separately, against a
-- disposable local-only probe function) — so this function's safety
-- does not come from "RPC calls are exempt" (they are not); it comes
-- from returning one row per DISTINCT GAMING MEMBER with positive
-- Global XP, not one row per event. Member count grows far slower
-- than event count, so this remains correct at Phase 1 scale and for
-- a long time after; a future p_limit/p_offset parameter, applied
-- outside the ranking subquery below, would remain correct even once
-- member count itself approaches the response-row limit, but is not
-- needed and not added now.
--
-- Canonical source of truth: Persistent_Metagame_Architecture.md's
-- "Global Leaderboard vs. Category Leaderboards" — ranks Gaming
-- Members by Global Gaming XP, SUM(gaming_xp_events.points) GROUP BY
-- gaming_member_id. Reversal-safe with no row-type filtering: a
-- reversal is always inserted as the exact negation of the award it
-- reverses (0090), so a plain SUM over every row — original,
-- reversal, and reissue alike — already nets correctly.
--
-- HAVING SUM(points) > 0 excludes any Gaming Member currently at zero
-- or negative effective Global XP — a brand-new member, a
-- TRAINING-only member, a member whose Experiences produced summaries
-- but no configured XP consequence, and a member whose full history
-- was reversed to net zero are all excluded identically. This is a
-- founder-confirmed Product decision, not an implementation
-- convenience: the public leaderboard represents current recognized
-- Gaming XP, never historical participation evidence. The full ledger
-- (including reversed and net-zero history) remains preserved and
-- readable by every existing per-member path; nothing here deletes or
-- hides it — only this aggregate, ranked, cross-member projection
-- excludes non-positive totals.
--
-- gaming_member_id is used only internally, as the deterministic
-- secondary ORDER BY key that decides tied-row print order — it is
-- never part of this function's own RETURNS TABLE shape, matching the
-- public/private profile boundary (display name + Global XP + Global
-- rank are public by default; nothing else about a Gaming Member is).
--
-- Competition ranking, not dense or ordinal: RANK() OVER (ORDER BY
-- total_xp DESC) alone determines the returned global_rank, so tied
-- members share a rank (100/100/80 -> 1/1/3). The deterministic
-- secondary key lives only in the outer ORDER BY, never inside the
-- RANK() window clause — putting it there would silently degrade
-- competition ranking into ordinal ranking, since gaming_member_id is
-- always distinct.

create function get_global_gaming_xp_leaderboard()
returns table (
  display_name text,
  total_xp bigint,
  global_rank bigint
)
language sql
security invoker
set search_path = public
stable
as $$
  select
    gm.display_name,
    totals.total_xp,
    rank() over (order by totals.total_xp desc) as global_rank
  from (
    select gaming_xp_events.gaming_member_id, sum(gaming_xp_events.points) as total_xp
    from gaming_xp_events
    group by gaming_xp_events.gaming_member_id
    having sum(gaming_xp_events.points) > 0
  ) totals
  join gaming_members gm on gm.gaming_member_id = totals.gaming_member_id
  order by totals.total_xp desc, totals.gaming_member_id asc;
$$;
