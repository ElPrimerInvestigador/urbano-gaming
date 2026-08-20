import { NextResponse } from "next/server";
import { joinTable } from "@/lib/gaming/poker/joinTable";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";
import {
  PokerTableNotFoundError,
  PokerTableClosedError,
  PokerTableFullError,
  PokerDisplayNameTakenError,
  PokerEmptyDisplayNameError,
  PokerDisplayNameTooLongError,
} from "@/lib/gaming/poker/types";

/**
 * POST /api/gaming/poker/tables/[identifier]/join — JOIN_POKER_TABLE
 *
 * [identifier] is the room code here (Next.js requires one shared slug
 * name across sibling dynamic routes at this path position — see
 * .../[identifier]/route.ts, where it is the poker_table_id instead —
 * mirrors the exact same identifier-name-vs-value split already
 * established by /api/sessions/[identifier]/join vs
 * /api/sessions/[identifier]).
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  const roomCode = params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  let displayName: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    displayName = body?.displayName;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof displayName !== "string") {
    return NextResponse.json(
      { error: "displayName is required and must be a string." },
      { status: 400 }
    );
  }

  const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await joinTable(repo, roomCode, displayName);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PokerTableNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PokerTableClosedError || err instanceof PokerTableFullError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof PokerDisplayNameTakenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof PokerEmptyDisplayNameError ||
      err instanceof PokerDisplayNameTooLongError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("JOIN_POKER_TABLE failed:", err);
    return NextResponse.json(
      { error: "Failed to join poker table." },
      { status: 500 }
    );
  }
}
