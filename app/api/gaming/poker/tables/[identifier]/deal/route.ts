import { NextResponse } from "next/server";
import { dealHand } from "@/lib/gaming/poker/dealHand";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";
import {
  PokerTableNotFoundError,
  PokerTableClosedError,
  PokerTableAccessDeniedError,
  NotEnoughSeatedPlayersError,
} from "@/lib/gaming/poker/types";

/**
 * POST /api/gaming/poker/tables/[identifier]/deal — DEAL_HAND
 *
 * Host-only: the bearer token must match this specific table's own
 * host_token, checked here (not inside dealHand.ts, which has no
 * concept of caller identity at all — it is host-authority-agnostic by
 * design, matching how finalizeMatchResult.ts also performs no
 * authority check of its own, leaving it to the API route). A
 * participant token, or any other table's host token, is rejected
 * identically to a missing header.
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  const pokerTableId = params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("authorization");
  const bearerMatch = authHeader?.match(/^Bearer (.+)$/i);
  if (!bearerMatch) {
    return NextResponse.json(
      { error: "A Bearer token is required in the Authorization header." },
      { status: 401 }
    );
  }
  const bearerToken = bearerMatch[1];

  const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceKey);

  try {
    const table = await repo.getTableById(pokerTableId);
    if (!table) {
      return NextResponse.json(
        { error: "No poker table exists for this id." },
        { status: 404 }
      );
    }
    if (bearerToken !== table.hostToken) {
      throw new PokerTableAccessDeniedError();
    }

    const result = await dealHand(repo, pokerTableId);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof PokerTableNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PokerTableAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof PokerTableClosedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof NotEnoughSeatedPlayersError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("DEAL_HAND failed:", err);
    return NextResponse.json(
      { error: "Failed to deal poker hand." },
      { status: 500 }
    );
  }
}
