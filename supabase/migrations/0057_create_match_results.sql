-- Migration: 0057_create_match_results
-- Soccer Predictions. Result entry is versioned, not a single mutable
-- row — "Enter Result" and "Finalize Result" are different states of
-- the SAME row (finalized_at null = draft, no settlement effect;
-- non-null = the immutable settlement boundary), and a post-
-- finalization correction is a NEW row rather than an edit to the old
-- one. Unchanged by the Founder's dimension-model correction.
--
-- supersedes_match_result_id: set only on a correction draft, pointing
-- at the finalized version it corrects. The partial unique index below
-- ensures a given finalized result can be superseded at most once.

create table match_results (
  match_result_id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches (match_id),
  home_score integer not null,
  away_score integer not null,
  finalized_at timestamptz null,
  supersedes_match_result_id uuid null references match_results (match_result_id),
  entered_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  created_at timestamptz not null default now()
);

alter table match_results
  add constraint match_results_scores_non_negative
  check (home_score >= 0 and away_score >= 0);

create index match_results_match_id_idx on match_results (match_id);

create unique index match_results_supersedes_unique
  on match_results (supersedes_match_result_id)
  where supersedes_match_result_id is not null;

create unique index match_results_one_draft_per_match
  on match_results (match_id)
  where finalized_at is null;
