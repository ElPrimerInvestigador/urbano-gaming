/**
 * Host token generation for CREATE_SESSION.
 *
 * Per the finalized data model: opaque, high-entropy, carries no embedded
 * claims, no expiry. Cryptographically secure randomness is used because
 * this is a security-bearing credential (unlike the room code, which is a
 * human-facing join string with no authority attached).
 */

import { randomBytes } from "crypto";

const HOST_TOKEN_BYTES = 32; // 256 bits of entropy

export function generateHostToken(): string {
  return randomBytes(HOST_TOKEN_BYTES).toString("base64url");
}
