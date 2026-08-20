import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabasePokerRepository } from "../lib/gaming/poker/db/supabasePokerRepository";
import { createTable } from "../lib/gaming/poker/createTable";
import { joinTable } from "../lib/gaming/poker/joinTable";
import { dealHand } from "../lib/gaming/poker/dealHand";
import { getTableState } from "../lib/gaming/poker/getTableState";
import {
  PokerDisplayNameTakenError,
  PokerTableAccessDeniedError,
} from "../lib/gaming/poker/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdTableIds: string[] = [];

afterAll(async () => {
  // Dependency order: poker_hands and poker_seats both reference
  // poker_tables with a plain FK (no cascade) — children first.
  for (const pokerTableId of createdTableIds) {
    await cleanupClient.from("poker_hands").delete().eq("poker_table_id", pokerTableId);
    await cleanupClient.from("poker_seats").delete().eq("poker_table_id", pokerTableId);
    await cleanupClient.from("poker_tables").delete().eq("poker_table_id", pokerTableId);
  }
});

describe("SupabasePokerRepository contract", () => {
  it("full foundation pipeline against real local Postgres: table, seats, deal, privacy, reconnect", async () => {
    const table = await createTable(repo);
    createdTableIds.push(table.pokerTableId);

    const alex = await joinTable(repo, table.roomCode, "Alex");
    const jordan = await joinTable(repo, table.roomCode, "Jordan");
    const sam = await joinTable(repo, table.roomCode, "Sam");
    expect([alex.seatNumber, jordan.seatNumber, sam.seatNumber]).toEqual([0, 1, 2]);

    await expect(joinTable(repo, table.roomCode, "alex")).rejects.toBeInstanceOf(
      PokerDisplayNameTakenError
    );

    const dealt = await dealHand(repo, table.pokerTableId);
    expect(dealt.alreadyDealt).toBe(false);
    expect(dealt.dealtSeatNumbers).toEqual([1, 2, 0]);

    const dealtAgain = await dealHand(repo, table.pokerTableId);
    expect(dealtAgain.alreadyDealt).toBe(true);
    expect(dealtAgain.pokerHandId).toBe(dealt.pokerHandId);

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const jordanState = await getTableState(repo, table.pokerTableId, jordan.participantToken);
    const samState = await getTableState(repo, table.pokerTableId, sam.participantToken);
    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);

    expect(alexState.myHoleCards).toHaveLength(2);
    expect(jordanState.myHoleCards).toHaveLength(2);
    expect(samState.myHoleCards).toHaveLength(2);
    expect(hostState.myHoleCards).toBeNull();

    const allCards = [
      ...alexState.myHoleCards!,
      ...jordanState.myHoleCards!,
      ...samState.myHoleCards!,
    ];
    expect(new Set(allCards).size).toBe(6);

    // Direct network-payload privacy inspection against the real
    // repository's actual serialization, not a UI-rendering assumption.
    const alexJson = JSON.stringify(alexState);
    for (const card of [...jordanState.myHoleCards!, ...samState.myHoleCards!]) {
      expect(alexJson).not.toContain(`"${card}"`);
    }
    expect(alexJson).not.toContain("deckOrder");
    const hostJson = JSON.stringify(hostState);
    expect(hostJson).not.toContain("deckOrder");
    for (const card of allCards) {
      expect(hostJson).not.toContain(`"${card}"`);
    }

    // Reconnect: same token, same cards.
    const alexReconnected = await getTableState(repo, table.pokerTableId, alex.participantToken);
    expect(alexReconnected.myHoleCards).toEqual(alexState.myHoleCards);

    // Unknown token rejected.
    await expect(
      getTableState(repo, table.pokerTableId, "not-a-real-token")
    ).rejects.toBeInstanceOf(PokerTableAccessDeniedError);

    // Mid-hand join: seated but no cards yet.
    const casey = await joinTable(repo, table.roomCode, "Casey");
    const caseyState = await getTableState(repo, table.pokerTableId, casey.participantToken);
    expect(caseyState.myHoleCards).toBeNull();
  }, 30000);

  it("concurrent joins against the same table allocate distinct, gapless seat numbers", async () => {
    const table = await createTable(repo);
    createdTableIds.push(table.pokerTableId);

    const results = await Promise.all(
      ["P1", "P2", "P3", "P4"].map((name) => joinTable(repo, table.roomCode, name))
    );
    const seatNumbers = results.map((r) => r.seatNumber).sort((a, b) => a - b);
    expect(seatNumbers).toEqual([0, 1, 2, 3]);
    expect(new Set(seatNumbers).size).toBe(4);
  }, 30000);

  it("concurrent double-tapped deal never produces two Hands for the same table", async () => {
    const table = await createTable(repo);
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");

    const [first, second] = await Promise.all([
      dealHand(repo, table.pokerTableId),
      dealHand(repo, table.pokerTableId),
    ]);

    // Exactly one of the two calls performed the real deal; the other
    // observed it as already dealt — never two distinct Hand rows.
    const alreadyDealtCount = [first.alreadyDealt, second.alreadyDealt].filter(Boolean).length;
    expect(alreadyDealtCount).toBe(1);
    expect(first.pokerHandId).toBe(second.pokerHandId);

    const { count } = await cleanupClient
      .from("poker_hands")
      .select("poker_hand_id", { count: "exact", head: true })
      .eq("poker_table_id", table.pokerTableId);
    expect(count).toBe(1);
  }, 30000);
});
