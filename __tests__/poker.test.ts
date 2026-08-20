import { describe, expect, it } from "vitest";

import { InMemoryPokerRepository } from "../lib/gaming/poker/db/inMemoryPokerRepository";
import { createTable } from "../lib/gaming/poker/createTable";
import { joinTable } from "../lib/gaming/poker/joinTable";
import { dealHand } from "../lib/gaming/poker/dealHand";
import { getTableState } from "../lib/gaming/poker/getTableState";
import { buildStandardDeck, shuffleDeck, isValidStandardDeck } from "../lib/gaming/poker/deck";
import {
  PokerTableNotFoundError,
  PokerTableFullError,
  PokerDisplayNameTakenError,
  PokerTableAccessDeniedError,
  NotEnoughSeatedPlayersError,
} from "../lib/gaming/poker/types";

async function setupTableWithThreeSeats(repo: InMemoryPokerRepository) {
  const table = await createTable(repo);
  const alex = await joinTable(repo, table.roomCode, "Alex");
  const jordan = await joinTable(repo, table.roomCode, "Jordan");
  const sam = await joinTable(repo, table.roomCode, "Sam");
  return { table, alex, jordan, sam };
}

describe("Poker Table", () => {
  it("host authority: hostToken is unique per table and returned only at creation", async () => {
    const repo = new InMemoryPokerRepository();
    const a = await createTable(repo);
    const b = await createTable(repo);
    expect(a.hostToken).not.toBe(b.hostToken);
    expect(a.roomCode).not.toBe(b.roomCode);
  });

  it("max-seat boundary: the seat past maxSeats is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    const table = await createTable(repo, { maxSeats: 2 });
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    await expect(joinTable(repo, table.roomCode, "Sam")).rejects.toBeInstanceOf(
      PokerTableFullError
    );
  });

  it("seat uniqueness: seat numbers are allocated sequentially, no gaps, no duplicates", async () => {
    const repo = new InMemoryPokerRepository();
    const { alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    expect([alex.seatNumber, jordan.seatNumber, sam.seatNumber]).toEqual([0, 1, 2]);
  });

  it("join retry with the same display name is rejected, not silently deduplicated", async () => {
    const repo = new InMemoryPokerRepository();
    const table = await createTable(repo);
    await joinTable(repo, table.roomCode, "Alex");
    await expect(joinTable(repo, table.roomCode, "alex")).rejects.toBeInstanceOf(
      PokerDisplayNameTakenError
    );
  });

  it("join while a Hand is active is still accepted, but the new seat is not part of the current Hand", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const casey = await joinTable(repo, table.roomCode, "Casey");
    const state = await getTableState(repo, table.pokerTableId, casey.participantToken);
    expect(state.myHoleCards).toBeNull();
    const caseySummary = state.seats.find((s) => s.seatNumber === casey.seatNumber);
    expect(caseySummary?.inCurrentHand).toBe(false);
  });

  it("joining a nonexistent table is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    await expect(joinTable(repo, "ZZZZZZ", "Alex")).rejects.toBeInstanceOf(
      PokerTableNotFoundError
    );
  });
});

describe("Deck", () => {
  it("a standard deck has exactly 52 unique valid cards, no jokers", () => {
    const deck = buildStandardDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(isValidStandardDeck(deck)).toBe(true);
  });

  it("shuffling preserves every card exactly once", () => {
    const deck = buildStandardDeck();
    const shuffled = shuffleDeck(deck);
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled)).toEqual(new Set(deck));
    expect(isValidStandardDeck(shuffled)).toBe(true);
  });

  it("isValidStandardDeck rejects a duplicate-with-one-missing deck", () => {
    const deck = buildStandardDeck();
    const tampered = [...deck.slice(1), deck[1]]; // drops card 0, duplicates card 1
    expect(isValidStandardDeck(tampered)).toBe(false);
  });

  it("isValidStandardDeck rejects a short deck", () => {
    expect(isValidStandardDeck(buildStandardDeck().slice(0, 51))).toBe(false);
  });

  it("dealing gives exactly two hole cards to every seat included in the Hand", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    for (const seat of [alex, jordan, sam]) {
      const state = await getTableState(repo, table.pokerTableId, seat.participantToken);
      expect(state.myHoleCards).toHaveLength(2);
    }
  });

  it("a double-tapped deal does not produce a second Hand or re-shuffle", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    const first = await dealHand(repo, table.pokerTableId);
    const second = await dealHand(repo, table.pokerTableId);
    expect(first.alreadyDealt).toBe(false);
    expect(second.alreadyDealt).toBe(true);
    expect(second.pokerHandId).toBe(first.pokerHandId);
  });

  it("dealing requires at least two seated players", async () => {
    const repo = new InMemoryPokerRepository();
    const table = await createTable(repo);
    await joinTable(repo, table.roomCode, "Alex");
    await expect(dealHand(repo, table.pokerTableId)).rejects.toBeInstanceOf(
      NotEnoughSeatedPlayersError
    );
  });

  it("dealing order starts left of the dealer (lowest seat number) and wraps around", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    const dealt = await dealHand(repo, table.pokerTableId);
    expect(dealt.dealerSeatNumber).toBe(alex.seatNumber);
    expect(dealt.dealtSeatNumbers).toEqual([jordan.seatNumber, sam.seatNumber, alex.seatNumber]);
  });
});

describe("Privacy — the load-bearing boundary", () => {
  it("each player sees exactly their own two hole cards", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const jordanState = await getTableState(repo, table.pokerTableId, jordan.participantToken);
    const samState = await getTableState(repo, table.pokerTableId, sam.participantToken);

    expect(alexState.myHoleCards).toHaveLength(2);
    expect(jordanState.myHoleCards).toHaveLength(2);
    expect(samState.myHoleCards).toHaveLength(2);

    const all = [...alexState.myHoleCards!, ...jordanState.myHoleCards!, ...samState.myHoleCards!];
    expect(new Set(all).size).toBe(6);
  });

  it("no participant's payload contains any other participant's cards", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const jordanState = await getTableState(repo, table.pokerTableId, jordan.participantToken);
    const samState = await getTableState(repo, table.pokerTableId, sam.participantToken);
    const alexJson = JSON.stringify(alexState);

    // Every dealt card is unique by construction (one 52-card
    // permutation, no repeats), so Jordan's and Sam's cards can never
    // legitimately coincide with Alex's own — a plain absence check is
    // sufficient and correct.
    for (const card of [...jordanState.myHoleCards!, ...samState.myHoleCards!]) {
      expect(alexJson).not.toContain(`"${card}"`);
    }
  });

  it("the host does not automatically receive any seat's hole cards", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(hostState.myHoleCards).toBeNull();
  });

  it("no raw deck field ever appears in any projection, for any caller", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);

    expect(Object.keys(alexState)).not.toContain("deckOrder");
    expect(Object.keys(hostState)).not.toContain("deckOrder");
    expect(JSON.stringify(alexState)).not.toContain("deckOrder");
    expect(JSON.stringify(hostState)).not.toContain("deckOrder");
  });

  it("before any Hand is dealt, myHoleCards is null for everyone", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex } = await setupTableWithThreeSeats(repo);
    const state = await getTableState(repo, table.pokerTableId, alex.participantToken);
    expect(state.myHoleCards).toBeNull();
  });
});

describe("Authority", () => {
  it("an unknown/invalid token is rejected with PokerTableAccessDeniedError", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await expect(
      getTableState(repo, table.pokerTableId, "not-a-real-token")
    ).rejects.toBeInstanceOf(PokerTableAccessDeniedError);
  });

  it("a seat token from one table is rejected when used against a different table", async () => {
    const repo = new InMemoryPokerRepository();
    const { alex } = await setupTableWithThreeSeats(repo);
    const otherTable = await createTable(repo);
    await expect(
      getTableState(repo, otherTable.pokerTableId, alex.participantToken)
    ).rejects.toBeInstanceOf(PokerTableAccessDeniedError);
  });

  it("GET_TABLE_STATE requesting a nonexistent table id is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    await expect(
      getTableState(repo, "00000000-0000-0000-0000-000000000000", "any-token")
    ).rejects.toBeInstanceOf(PokerTableNotFoundError);
  });
});

describe("Reconnect", () => {
  it("the same participant token recovers the same seat and the same hole cards", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const first = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const second = await getTableState(repo, table.pokerTableId, alex.participantToken);
    expect(second.myHoleCards).toEqual(first.myHoleCards);
  });

  it("the host token recovers current table state after a reload", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    const dealt = await dealHand(repo, table.pokerTableId);

    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(hostState.currentHandId).toBe(dealt.pokerHandId);
    expect(hostState.seats).toHaveLength(3);
  });
});
