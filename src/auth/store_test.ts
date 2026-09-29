import { assert, assertEquals, assertNotEquals } from "@std/assert";
import * as store from "./store.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("pkceMatches implements S256 (RFC 7636 appendix B vector)", async () => {
  assert(await store.pkceMatches(
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  ));
  assert(!(await store.pkceMatches("wrong", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")));
});

Deno.test("registered clients can be read back", async () => {
  await withKv(async (kv) => {
    const c = await store.registerClient(kv, ["https://a/cb"], "ChatGPT");
    assertEquals(await store.getClient(kv, c.clientId), c);
    assertEquals(await store.getClient(kv, "nope"), null);
  });
});

Deno.test("authorization codes are single use", async () => {
  await withKv(async (kv) => {
    const grant = { clientId: "c", redirectUri: "https://a/cb", codeChallenge: "x" };
    const code = await store.issueCode(kv, grant, NOW);
    assertEquals((await store.takeCode(kv, code, NOW))?.clientId, "c");
    assertEquals(await store.takeCode(kv, code, NOW), null);
  });
});

Deno.test("expired codes and pending logins are rejected", async () => {
  await withKv(async (kv) => {
    const code = await store.issueCode(kv, { clientId: "c", redirectUri: "r", codeChallenge: "x" }, NOW);
    assertEquals(await store.takeCode(kv, code, NOW + 5 * 60_000 + 1), null);
    await store.savePending(kv, "s", { clientId: "c", redirectUri: "r", codeChallenge: "x" }, NOW);
    assertEquals(await store.takePending(kv, "s", NOW + 10 * 60_000 + 1), null);
  });
});

Deno.test("access tokens verify until they expire", async () => {
  await withKv(async (kv) => {
    const t = await store.issueTokens(kv, "c", NOW);
    assertEquals(t.token_type, "Bearer");
    assertEquals(t.expires_in, 3600);
    assert(await store.verifyAccessToken(kv, t.access_token, NOW));
    assert(!(await store.verifyAccessToken(kv, t.access_token, NOW + store.ACCESS_TTL_MS)));
    assert(!(await store.verifyAccessToken(kv, "garbage", NOW)));
  });
});

Deno.test("refresh tokens rotate, are single use, and are bound to their client", async () => {
  await withKv(async (kv) => {
    const t1 = await store.issueTokens(kv, "c", NOW);
    assertEquals(await store.rotateRefreshToken(kv, t1.refresh_token, "other-client", NOW), null);
    const t2 = await store.issueTokens(kv, "c", NOW);
    const t3 = await store.rotateRefreshToken(kv, t2.refresh_token, "c", NOW);
    assert(t3);
    assertNotEquals(t3.refresh_token, t2.refresh_token);
    assertEquals(await store.rotateRefreshToken(kv, t2.refresh_token, "c", NOW), null);
  });
});

Deno.test("revokeAllTokens invalidates access and refresh tokens", async () => {
  await withKv(async (kv) => {
    const t = await store.issueTokens(kv, "c", NOW);
    await store.revokeAllTokens(kv);
    assert(!(await store.verifyAccessToken(kv, t.access_token, NOW)));
    assertEquals(await store.rotateRefreshToken(kv, t.refresh_token, "c", NOW), null);
  });
});
