import { NextResponse } from "next/server";
import { createSession } from "@/lib/session/createSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";

/**
 * POST /api/sessions  — CREATE_SESSION
 *
 * Host-initiated only. No request body fields are accepted as canonical
 * input (no client-supplied state, state_version, host_token, or
 * timestamps) — everything server-assigned, per the authority model.
 *
 * This route is thin by design: transport concerns only. All logic lives
 * in createSession(), which is transport-agnostic and unit-tested
 * independent of this route.
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

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await createSession(repo);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("CREATE_SESSION failed:", err);
    return NextResponse.json(
      { error: "Failed to create session." },
      { status: 500 }
    );
  }
}
