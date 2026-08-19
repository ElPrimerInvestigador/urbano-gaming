import { afterEach, describe, expect, it } from "vitest";

import { GET } from "../app/api/gaming/config/route";

/**
 * URBANO Gaming Identity Foundation — security boundary regression.
 *
 * GET /api/gaming/config is the one route a browser ever calls to learn
 * its Supabase configuration. This test proves, structurally, that its
 * response can never carry the service_role key — even if
 * SUPABASE_SERVICE_ROLE_KEY is set in the exact same process (as it
 * always is server-side), the response body contains only the two
 * browser-safe fields and nothing else, by name and by content.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/gaming/config — service_role exposure boundary", () => {
  it("never includes the service_role key, even when it is present in the same process", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-key-value";
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      "SENTINEL_SERVICE_ROLE_VALUE_MUST_NEVER_LEAK";

    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;
    const rawBody = JSON.stringify(body);

    expect(Object.keys(body).sort()).toEqual(["supabaseAnonKey", "supabaseUrl"]);
    expect(body.supabaseUrl).toBe("https://example.supabase.co");
    expect(body.supabaseAnonKey).toBe("anon-key-value");
    expect(rawBody).not.toContain("SENTINEL_SERVICE_ROLE_VALUE_MUST_NEVER_LEAK");
    expect(rawBody.toLowerCase()).not.toContain("service_role");
    expect(rawBody.toLowerCase()).not.toContain("servicerole");
  });

  it("returns 500 and no config fields when browser-safe configuration is unset", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "SENTINEL_SERVICE_ROLE_VALUE";

    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body.supabaseUrl).toBeUndefined();
    expect(body.supabaseAnonKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("SENTINEL_SERVICE_ROLE_VALUE");
  });
});
