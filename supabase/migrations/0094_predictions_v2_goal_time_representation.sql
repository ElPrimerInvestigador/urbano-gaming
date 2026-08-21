-- Migration: 0094_predictions_v2_goal_time_representation
-- Soccer Predictions v2 — Goal-Time correctness fix.
--
-- 0056's own predicted_goal_minute (a single flattened elapsed-minute
-- integer) is dropped, not merely deprecated: its own governing
-- comment claimed "no ambiguity is lost, only the member-facing
-- distinction between 'which period' is" — that claim is factually
-- wrong for first-half stoppage specifically. 45+10 sums to the same
-- integer (55) as an ordinary open-play minute 55, a genuine
-- collision between two different real match moments, not merely a
-- lost label. (Second-half stoppage never collided this way — 90+N
-- sums past 90, where no ordinary minute exists — but the flattening
-- still discarded period identity there too, and the correction below
-- restores it uniformly rather than fixing only the collision case.)
--
-- Replaced with the identical structural primitive already accepted
-- and proven on the official side (0058): a (regulation, stoppage)
-- pair, never summed at storage time. No competing representation is
-- introduced — this migration makes predictions use the *same* shape
-- official_goal_events already uses, not a third one.
--
--   ordinary 46      -> (regulation: 46, stoppage: null)
--   first-half 45+3  -> (regulation: 45, stoppage: 3)
--   second-half 90+6 -> (regulation: 90, stoppage: 6)
--   No Goal          -> (regulation: null, stoppage: null)
--
-- Two structural differences from official_goal_events' own, wider
-- constraints, both deliberate:
--
-- 1. predicted_goal_minute_regulation is bounded 1-90, not 1-120.
--    Predictions-v2's Any Goal Minute dimension is explicitly scoped
--    to regulation time only (extra time is out of the canonical
--    prediction boundary entirely) — allowing a member to "predict" a
--    minute that can structurally never be evaluated as correct would
--    be a real data-quality trap, not a harmless wider range.
--
-- 2. predicted_goal_minute_stoppage may only be non-null when
--    regulation is exactly 45 or 90 — stoppage time is only ever
--    added at the end of a half. This constraint is intentionally
--    NOT mirrored back onto official_goal_events (see that table's
--    own migration comment, unedited here): official evidence must
--    keep the ability to record extra-time stoppage (105+N, 120+N)
--    operationally, which this narrower, prediction-only constraint
--    would incorrectly forbid if applied there.
--
-- No maximum stoppage offset is introduced, matching
-- official_goal_events' own precedent (minute_stoppage is bounded only
-- by > 0, never by an upper ceiling) — there is no Product-authorized
-- maximum, and inventing one here would be exactly the kind of
-- convenience-driven schema decision this correction exists to avoid
-- elsewhere.
--
-- Production holds zero predictions rows (independently reconfirmed
-- immediately before this migration was authored) — this is a clean
-- drop-and-replace, not a backfill.

alter table predictions
  drop column predicted_goal_minute;

alter table predictions
  add column predicted_goal_minute_regulation integer null,
  add column predicted_goal_minute_stoppage integer null;

alter table predictions
  add constraint predictions_goal_minute_regulation_range
  check (predicted_goal_minute_regulation is null or predicted_goal_minute_regulation between 1 and 90);

alter table predictions
  add constraint predictions_goal_minute_stoppage_positive
  check (predicted_goal_minute_stoppage is null or predicted_goal_minute_stoppage > 0);

-- Stoppage may only accompany a boundary regulation minute (45 or
-- 90); this single constraint also transitively forbids the
-- regulation-null/stoppage-non-null shape, since NULL never satisfies
-- "in (45, 90)".
alter table predictions
  add constraint predictions_goal_minute_stoppage_requires_boundary
  check (
    predicted_goal_minute_stoppage is null
    or (predicted_goal_minute_regulation is not null and predicted_goal_minute_regulation in (45, 90))
  );
