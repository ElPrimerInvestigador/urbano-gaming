import { NextResponse } from "next/server";
import { createTable } from "@/lib/gaming/poker/createTable";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";

/**
 * POST /api/gaming/poker/tables — CREATE_POKER_TABLE
 *
 * Host-initiated only, no auth required — mirrors POST /api/sessions
 * exactly. Poker does not depend on Gaming Member authentication; the
 * host token returned here is this table's entire host authority.
 * Body fields are all optional gameplay config (maxSeats, startingStack,
 * smallBlind, bigBlind) — createTable.ts applies sane defaults and
 * validates whatever is supplied.
 */
export async function POST(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { maxSeats, startingStack, smallBlind, bigBlind } = body;
  const config: { maxSeats?: number; startingStack?: number; smallBlind?: number; bigBlind?: number } = {};
  if (typeof maxSeats === "number") config.maxSeats = maxSeats;
  if (typeof startingStack === "number") config.startingStack = startingStack;
  if (typeof smallBlind === "number") config.smallBlind = smallBlind;
  if (typeof bigBlind === "number") config.bigBlind = bigBlind;

  const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await createTable(repo, config);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Poker table")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("CREATE_POKER_TABLE failed:", err);
    return NextResponse.json(
      { error: "Failed to create poker table." },
      { status: 500 }
    );
  }
}
