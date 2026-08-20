import { NextResponse } from "next/server";
import { applyPlayerAction } from "@/lib/gaming/poker/applyPlayerAction";
import { SupabasePokerRepository } from "@/lib/gaming/poker/db/supabasePokerRepository";
import {
  PokerTableNotFoundError,
  PokerTableAccessDeniedError,
  PokerHandNotFoundError,
  HandNotAcceptingActionsError,
  NotYourTurnError,
  SeatNotInHandError,
  SeatNotEligibleToActError,
  IllegalActionError,
  InvalidActionAmountError,
} from "@/lib/gaming/poker/types";

const VALID_ACTION_TYPES = ["FOLD", "CHECK", "CALL", "BET", "RAISE", "ALL_IN"];

/**
 * POST /api/gaming/poker/tables/[identifier]/action — PLAYER_ACTION
 *
 * Participant-only: the bearer token must resolve to a seat at this
 * specific table (checked here via getTableState.ts's own bearer-
 * token resolution, reused rather than duplicated). The acting seat
 * number is always the token's own seat — never accepted from the
 * request body — so a participant can only ever act as themselves,
 * mirroring how JOIN_SESSION's gamingMemberId is always the verified
 * caller's own.
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { pokerHandId, actionType, amount, idempotencyKey } = body;
  if (
    typeof pokerHandId !== "string" ||
    typeof actionType !== "string" ||
    !VALID_ACTION_TYPES.includes(actionType) ||
    !(amount === null || amount === undefined || typeof amount === "number") ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length === 0
  ) {
    return NextResponse.json({ error: "Invalid action payload." }, { status: 400 });
  }

  const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceKey);

  try {
    const table = await repo.getTableById(pokerTableId);
    if (!table) {
      return NextResponse.json({ error: "No poker table exists for this id." }, { status: 404 });
    }
    const seats = await repo.listSeatsForTable(pokerTableId);
    const callingSeat = seats.find((s) => s.participantToken === bearerToken);
    if (!callingSeat) {
      throw new PokerTableAccessDeniedError();
    }

    const result = await applyPlayerAction(repo, {
      pokerHandId,
      seatNumber: callingSeat.seatNumber,
      actionType: actionType as any,
      amount: typeof amount === "number" ? amount : null,
      idempotencyKey,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof PokerTableNotFoundError || err instanceof PokerHandNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PokerTableAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (
      err instanceof HandNotAcceptingActionsError ||
      err instanceof NotYourTurnError ||
      err instanceof SeatNotInHandError ||
      err instanceof SeatNotEligibleToActError ||
      err instanceof IllegalActionError
    ) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidActionAmountError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("PLAYER_ACTION failed:", err);
    return NextResponse.json({ error: "Failed to apply player action." }, { status: 500 });
  }
}
