import { NextResponse } from "next/server";
import { getSession } from "@/lib/session/getSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import { SessionNotFoundError, SessionAccessDeniedError } from "@/lib/session/types";

/**
 * GET /api/sessions/[identifier] — GET_SESSION
 *
 * The dynamic segment is named [identifier] (not [sessionId]) for the
 * same reason the join/lock routes share it — see those routes' doc
 * comments. For this route, the value is the session id.
 *
 * Authorization is via a bearer token (either the session's host token
 * or a participant's token) in the Authorization header — never a
 * query parameter or request body. Route is thin by design: header
 * extraction only. All logic lives in getSession(), which is
 * transport-agnostic and unit-tested independent of this route.
 */
export async function GET(
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

  // Scheme name is matched case-insensitively per RFC 7235 (HTTP auth
  // schemes are case-insensitive) — only the "Bearer" literal, not the
  // captured token itself, which remains an exact, case-sensitive value.
  const authHeader = request.headers.get("authorization");
  const bearerMatch = authHeader?.match(/^Bearer (.+)$/i);

  if (!bearerMatch) {
    return NextResponse.json(
      { error: "A Bearer token is required in the Authorization header." },
      { status: 401 }
    );
  }

  const bearerToken = bearerMatch[1];
  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await getSession(repo, sessionId, bearerToken);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof SessionAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }

    console.error("GET_SESSION failed:", err);
    return NextResponse.json(
      { error: "Failed to retrieve session." },
      { status: 500 }
    );
  }
}
