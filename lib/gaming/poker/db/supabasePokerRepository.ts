import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

import type { PokerRepository } from "./pokerRepository";
import type { PokerTableRecord, PokerSeatRecord, PokerHandRecord } from "../types";
import {
  PokerRoomCodeCollisionError,
  PokerTableNotFoundError,
  PokerTableClosedError,
  PokerTableFullError,
  PokerDisplayNameTakenError,
  NotEnoughSeatedPlayersError,
} from "../types";

function mapTable(row: any): PokerTableRecord {
  return {
    pokerTableId: row.poker_table_id,
    roomCode: row.room_code,
    hostToken: row.host_token,
    maxSeats: row.max_seats,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

function mapSeat(row: any): PokerSeatRecord {
  return {
    pokerSeatId: row.poker_seat_id,
    pokerTableId: row.poker_table_id,
    seatNumber: row.seat_number,
    displayName: row.display_name,
    normalizedDisplayName: row.normalized_display_name,
    participantToken: row.participant_token,
    joinedAt: row.joined_at,
  };
}

/**
 * deckOrder is only ever read here from an RPC response that this
 * function itself controls (dealHand/getCurrentHandForTable below) —
 * never spread from a raw `.select("*")` row into any DTO that could
 * reach an API route without passing through getTableState.ts's own
 * explicit-projection discipline first.
 */
function mapHand(row: any): PokerHandRecord {
  return {
    pokerHandId: row.poker_hand_id,
    pokerTableId: row.poker_table_id,
    handOrdinal: row.hand_ordinal,
    dealerSeatNumber: row.dealer_seat_number,
    dealtSeatNumbers: row.dealt_seat_numbers,
    deckOrder: row.deck_order,
    dealtAt: row.dealt_at ?? row.created_at,
  };
}

function translateNamedError(error: { code?: string; message?: string }): Error | null {
  if (error.code !== "P0001" || typeof error.message !== "string") return null;
  const table: Array<[string, () => Error]> = [
    ["POKER_TABLE_NOT_FOUND", () => new PokerTableNotFoundError()],
    ["POKER_TABLE_CLOSED", () => new PokerTableClosedError()],
    ["POKER_TABLE_FULL", () => new PokerTableFullError()],
    ["NOT_ENOUGH_SEATED_PLAYERS", () => new NotEnoughSeatedPlayersError()],
  ];
  for (const [code, build] of table) {
    if (error.message.includes(code)) return build();
  }
  return null;
}

export class SupabasePokerRepository implements PokerRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    // Same Next.js Data Cache workaround already established for
    // Predictions (see supabasePredictionsRepository.ts's own comment)
    // — applied here proactively rather than rediscovered the same way.
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, cache: "no-store" } as RequestInit),
      },
    });
  }

  async createTable(record: PokerTableRecord): Promise<void> {
    const { error } = await this.client.from("poker_tables").insert({
      poker_table_id: record.pokerTableId,
      room_code: record.roomCode,
      host_token: record.hostToken,
      max_seats: record.maxSeats,
    });
    if (error) {
      if (error.code === "23505" && error.message.includes("poker_tables_room_code_active_unique")) {
        throw new PokerRoomCodeCollisionError();
      }
      throw error;
    }
  }

  async getTableById(pokerTableId: string): Promise<PokerTableRecord | null> {
    const { data, error } = await this.client
      .from("poker_tables")
      .select("*")
      .eq("poker_table_id", pokerTableId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapTable(data) : null;
  }

  async getActiveTableByRoomCode(roomCode: string): Promise<PokerTableRecord | null> {
    const { data, error } = await this.client
      .from("poker_tables")
      .select("*")
      .eq("room_code", roomCode)
      .is("closed_at", null)
      .maybeSingle();
    if (error) throw error;
    return data ? mapTable(data) : null;
  }

  async joinTable(input: {
    pokerTableId: string;
    displayName: string;
    normalizedDisplayName: string;
    participantToken: string;
  }): Promise<PokerSeatRecord> {
    const { data, error } = await this.client.rpc("join_poker_table_atomically", {
      p_poker_seat_id: randomUUID(),
      p_poker_table_id: input.pokerTableId,
      p_display_name: input.displayName,
      p_normalized_display_name: input.normalizedDisplayName,
      p_participant_token: input.participantToken,
      p_joined_at: new Date().toISOString(),
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      if (
        error.code === "23505" &&
        error.message.includes("poker_seats_table_display_name_unique")
      ) {
        throw new PokerDisplayNameTakenError();
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return mapSeat(row);
  }

  async listSeatsForTable(pokerTableId: string): Promise<PokerSeatRecord[]> {
    const { data, error } = await this.client
      .from("poker_seats")
      .select("*")
      .eq("poker_table_id", pokerTableId)
      .order("seat_number");
    if (error) throw error;
    return (data ?? []).map(mapSeat);
  }

  async dealHand(input: {
    pokerTableId: string;
    dealerSeatNumber: number;
    dealtSeatNumbers: number[];
    deckOrder: string[];
  }): Promise<{ hand: PokerHandRecord; alreadyDealt: boolean }> {
    const { data, error } = await this.client.rpc("deal_poker_hand_atomically", {
      p_poker_hand_id: randomUUID(),
      p_poker_table_id: input.pokerTableId,
      p_dealer_seat_number: input.dealerSeatNumber,
      p_dealt_seat_numbers: input.dealtSeatNumbers,
      p_deck_order: input.deckOrder,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    const alreadyDealt = row.already_dealt as boolean;

    // The RPC's own return shape deliberately omits deck_order (it was
    // never selected as an output column in 0071) — already_dealt:true
    // still needs the full Hand (including deck_order) for
    // getTableState.ts to compute hole cards, so it is fetched
    // explicitly here rather than trusted from the RPC response.
    const hand = await this.getCurrentHandForTable(input.pokerTableId);
    if (!hand) {
      throw new Error("deal_poker_hand_atomically reported success but no Hand row was found.");
    }

    return { hand, alreadyDealt };
  }

  async getCurrentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null> {
    const { data, error } = await this.client
      .from("poker_hands")
      .select("*")
      .eq("poker_table_id", pokerTableId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapHand(data) : null;
  }
}
