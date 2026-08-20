import { NextResponse } from "next/server";
import { createTable } from "@/lib/gaming/poker/createTable";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";

/**
 * POST /api/gaming/poker/tables — CREATE_POKER_TABLE
 *
 * Host-initiated only, no request body fields accepted as canonical
 * input, no auth required — mirrors POST /api/sessions exactly. Poker
 * does not depend on Gaming Member authentication; the host token
 * returned here is this table's entire host authority.
 */
export async function POST() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await createTable(repo);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("CREATE_POKER_TABLE failed:", err);
    return NextResponse.json(
      { error: "Failed to create poker table." },
      { status: 500 }
    );
  }
}
