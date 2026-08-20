import { NextResponse } from "next/server";
import { startHand } from "@/lib/gaming/poker/startHand";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";
import {
  PokerTableNotFoundError,
  PokerTableClosedError,
  PokerTableAccessDeniedError,
  NotEnoughSeatedPlayersError,
} from "@/lib/gaming/poker/types";

/**
 * POST /api/gaming/poker/tables/[identifier]/hand — START_HAND / NEXT_HAND
 *
 * Host-only, same authority pattern as .../deal (Poker Foundation).
 * One command for both the very first Hand and every subsequent one —
 * startHand.ts itself determines which via the table's own most
 * recent Hand state. Idempotent: a double-tapped "Start Hand"/"Next
 * Hand" returns the existing in-progress Hand rather than starting a
 * second one.
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

    const result = await startHand(repo, pokerTableId);
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

    console.error("START_HAND failed:", err);
    return NextResponse.json(
      { error: "Failed to start poker hand." },
      { status: 500 }
    );
  }
}
