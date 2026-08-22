import { NextResponse } from "next/server";
import { setSessionCapabilities } from "@/lib/session/setSessionCapabilities";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  InvalidCapabilityKeyError,
  CapabilitiesLockedError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/capabilities — SET_SESSION_CAPABILITIES
 *
 * Session Capability Architecture v1. The dynamic segment is named
 * [identifier] (not [sessionId]) for the same reason every sibling
 * route at this path position shares it — see /lock's own doc
 * comment. For this route, the value is the session id.
 *
 * Host-authenticated only, via the host token issued at CREATE_SESSION.
 * Route is thin by design, mirroring /lock: transport concerns only.
 * All logic lives in setSessionCapabilities(), which is
 * transport-agnostic and unit-tested independent of this route.
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  const sessionId = params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  let hostToken: unknown;
  let capabilities: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    capabilities = body?.capabilities;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof hostToken !== "string" || hostToken.length === 0) {
    return NextResponse.json(
      { error: "hostToken is required and must be a string." },
      { status: 400 }
    );
  }

  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((c) => typeof c === "string")
  ) {
    return NextResponse.json(
      { error: "capabilities is required and must be an array of strings." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await setSessionCapabilities(
      repo,
      sessionId,
      hostToken,
      capabilities
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof InvalidCapabilityKeyError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof CapabilitiesLockedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("SET_SESSION_CAPABILITIES failed:", err);
    return NextResponse.json(
      { error: "Failed to set session capabilities." },
      { status: 500 }
    );
  }
}
