-- Migration: 0047_create_gaming_member_atomically
-- URBANO Gaming Identity Foundation.
--
-- CREATE_GAMING_MEMBER: the one-time transition from "authenticated
-- Supabase Auth user with no completed profile" to "Gaming Member."
-- Deliberately the only writer of the gaming_members table (besides its
-- own on delete cascade from auth.users) — there is no separate
-- "resolve" SQL function, since resolution is a plain read
-- (`select ... from gaming_members where auth_user_id = ...`),
-- consistent with this codebase's existing convention of reserving
-- dedicated atomic functions for writes with real invariants to
-- protect (e.g. getQuizWindowForSegment is a plain select; only its
-- mutating counterparts get RPC functions).
--
-- Idempotent under retry/concurrency by construction, mirroring
-- award_points_atomically's own race-loss handling: ON CONFLICT
-- (auth_user_id) DO NOTHING absorbs a concurrent duplicate create for
-- the same auth_user_id (e.g. two browser tabs both completing the
-- profile step at once); if this call loses that race, it re-selects
-- and returns the winner's row rather than erroring. Both the winner
-- and the loser observe the same final row — this function never
-- creates a second Gaming Member for one auth_user_id, and it never
-- overwrites an existing display_name with a caller's later value.
--
-- p_auth_user_id must already be a verified auth.users id — this
-- function trusts its caller completely and performs no independent
-- verification. It is never invoked with a client-supplied
-- auth_user_id; the caller (lib/gaming's server-side JWT verification)
-- is solely responsible for resolving this value from a verified
-- Supabase Auth token before calling this function. See
-- IDENTITY_FOUNDATION_IMPLEMENTATION_RECORD.md.

create function create_gaming_member_atomically(
  p_auth_user_id uuid,
  p_display_name text
)
returns table (
  gaming_member_id uuid,
  auth_user_id uuid,
  display_name text,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_new_id uuid;
begin
  insert into gaming_members (auth_user_id, display_name)
  values (p_auth_user_id, p_display_name)
  on conflict (auth_user_id) do nothing
  returning gaming_members.gaming_member_id into v_new_id;

  if v_new_id is not null then
    return query
      select gaming_members.gaming_member_id, gaming_members.auth_user_id,
             gaming_members.display_name, gaming_members.created_at
      from gaming_members
      where gaming_members.gaming_member_id = v_new_id;
    return;
  end if;

  -- Lost the race: a concurrent call already created this
  -- auth_user_id's Gaming Member. Return its existing row rather than
  -- erroring — this call is a legitimate duplicate of one that just
  -- succeeded, not a conflict.
  return query
    select gaming_members.gaming_member_id, gaming_members.auth_user_id,
           gaming_members.display_name, gaming_members.created_at
    from gaming_members
    where gaming_members.auth_user_id = p_auth_user_id;
end;
$$;
