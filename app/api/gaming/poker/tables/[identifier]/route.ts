import { NextResponse } from "next/server";
import { getTableState } from "@/lib/gaming/poker/getTableState";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";
import { PokerTableNotFoundError, PokerTableAccessDeniedError } from "@/lib/gaming/poker/types";

/**
 * GET /api/gaming/poker/tables/[identifier] — GET_TABLE_STATE
 *
 * [identifier] is the poker_table_id here. Authorization via a bearer
 * token (host token or a seat's participant token) in the
 * Authorization header only — never a query parameter or body,
 * mirroring GET /api/sessions/[identifier] exactly. All privacy logic
 * lives in getTableState(), transport-agnostic and independently
 * tested — this route performs no projection of its own.
 */
export async function GET(
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
    const result = await getTableState(repo, pokerTableId, bearerToken);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof PokerTableNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PokerTableAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }

    console.error("GET_TABLE_STATE failed:", err);
    return NextResponse.json(
      { error: "Failed to retrieve poker table state." },
      { status: 500 }
    );
  }
}
