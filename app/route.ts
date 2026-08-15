import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

/**
 * GET /  — URBANO Gaming Application Shell landing page.
 *
 * Next.js's public/ folder is not served at the bare root the way a
 * plain static file server would ("public/index.html" only resolves at
 * the literal path "/index.html") — a next.config.cjs rewrite was
 * tried first and did not reach the static file, because the App
 * Router (app/api/...) claims an unmatched "/" as its own not-found
 * page before any ordinary rewrite runs. This route handler is the
 * same thin-route pattern already used throughout app/api/ — it simply
 * serves public/index.html's own markup at "/", rather than
 * introducing a React page for what is, everywhere else in this
 * repository, plain static HTML (host.html, participant.html).
 */
export async function GET() {
  const html = await readFile(
    path.join(process.cwd(), "public", "index.html"),
    "utf-8"
  );
  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
