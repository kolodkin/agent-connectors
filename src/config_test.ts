import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";

const env = (vars: Record<string, string>) => (name: string) => vars[name];
const FULL = {
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "s",
  ALLOWED_EMAIL: "Me@Example.com",
  BASE_URL: "https://x.deno.dev/",
};

Deno.test("loadConfig reads vars, normalizes email and base url, defaults TZ", () => {
  assertEquals(loadConfig(env(FULL)), {
    googleClientId: "id",
    googleClientSecret: "s",
    allowedEmail: "me@example.com",
    baseUrl: "https://x.deno.dev",
    tz: "UTC",
  });
});

Deno.test("loadConfig lists every missing var", () => {
  assertThrows(
    () => loadConfig(env({ BASE_URL: "https://x" })),
    Error,
    "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAIL",
  );
});

Deno.test("loadConfig rejects an unknown timezone", () => {
  assertThrows(() => loadConfig(env({ ...FULL, TZ: "Mars/Base" })), Error, "Invalid TZ");
});
