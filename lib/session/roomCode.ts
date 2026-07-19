/**
 * Room code generation for CREATE_SESSION.
 *
 * Scope: generation of the candidate string only. Uniqueness enforcement
 * against active sessions happens at the persistence layer (see
 * db/sessionRepository.ts), not here — this module has no knowledge of
 * other sessions.
 *
 * Character set deliberately excludes visually confusable characters
 * (0/O, 1/I/L) per the finalized data model, since room codes must be
 * readable/typable under time pressure on a phone.
 */

const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const index = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[index];
  }
  return code;
}
