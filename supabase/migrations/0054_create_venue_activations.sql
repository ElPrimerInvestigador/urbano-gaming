-- Migration: 0054_create_venue_activations
-- Soccer Predictions. The specific (Match, Venue) pairing that makes a
-- Match predictable-with-prize-eligibility at a given physical place.
-- UNIQUE(match_id, venue_id): at most one Activation per Match per
-- Venue.

create table venue_activations (
  venue_activation_id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches (match_id),
  venue_id uuid not null references venues (venue_id),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (match_id, venue_id)
);

create index venue_activations_match_id_idx on venue_activations (match_id);
create index venue_activations_venue_id_idx on venue_activations (venue_id);
