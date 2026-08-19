import { NextResponse } from "next/server";

/**
 * GET /api/gaming/config — browser-safe Supabase configuration.
 *
 * public/*.html pages are served as raw, unbundled static assets — this
 * repository has no next.config.js and no webpack/bundler step touches
 * them, so Next.js's build-time NEXT_PUBLIC_* env var inlining cannot
 * reach them (confirmed directly: no next.config.js/mjs exists in this
 * repo at all). This route exists specifically to bridge that gap: a
 * thin, server-rendered JSON endpoint public/urbanoAuth.js fetches once
 * on init, consistent with this codebase's existing 100%-API-route
 * architecture rather than introducing a bundler.
 *
 * SUPABASE_ANON_KEY is browser-public by design (Supabase's anon key is
 * meant to be shipped to clients — it carries no elevated privilege and
 * is subject to the project's RLS posture) but is still centrally
 * configured server-side rather than hardcoded into a static file, so
 * it can differ between local/staging/production without editing
 * public/*.html. Never exposes SUPABASE_SERVICE_ROLE_KEY.
 */
export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      {
        error:
          "Server misconfiguration: browser Supabase configuration not set.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ supabaseUrl, supabaseAnonKey });
}
