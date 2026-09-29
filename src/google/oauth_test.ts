import { assert, assertEquals, assertRejects } from "@std/assert";
import { fakeIdToken, json, type Route, withCtx } from "../testing.ts";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  getAccessToken,
  GOOGLE_TOKEN_URL,
  GoogleAuthExpiredError,
  type GoogleLogin,
  hasGoogleTokens,
  saveGoogleLogin,
} from "./oauth.ts";

const TOKEN = `POST ${GOOGLE_TOKEN_URL}`;
const NOW = Date.parse("2026-09-29T12:00:00Z");
const login = (over: Partial<GoogleLogin> = {}): GoogleLogin => ({
  email: "owner@example.com",
  emailVerified: true,
  refreshToken: "r1",
  accessToken: "a1",
  expiresAt: NOW + 3600_000,
  ...over,
});

Deno.test("auth url asks for offline access, our scopes, and consent when no token is stored", async () => {
  await withCtx({}, async (ctx) => {
    const url = new URL(await buildGoogleAuthUrl(ctx, "st", ["scope.a"]));
    assertEquals(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assertEquals(url.searchParams.get("scope"), "openid email scope.a");
    assertEquals(url.searchParams.get("access_type"), "offline");
    assertEquals(url.searchParams.get("redirect_uri"), "https://conn.example.com/oauth/google/callback");
    assertEquals(url.searchParams.get("state"), "st");
    assertEquals(url.searchParams.get("prompt"), "consent");
    assertEquals(url.searchParams.has("include_granted_scopes"), false);
  });
});

Deno.test("auth url omits prompt=consent once a refresh token is stored", async () => {
  await withCtx({}, async (ctx) => {
    await saveGoogleLogin(ctx, login());
    const url = new URL(await buildGoogleAuthUrl(ctx, "st", []));
    assertEquals(url.searchParams.has("prompt"), false);
  });
});

Deno.test("exchangeGoogleCode posts the code and reads email from the id token", async () => {
  const routes: Record<string, Route> = {
    [TOKEN]: async (req) => {
      const form = new URLSearchParams(await req.text());
      assertEquals(form.get("grant_type"), "authorization_code");
      assertEquals(form.get("code"), "c1");
      assertEquals(form.get("client_secret"), "gsecret");
      return json({
        access_token: "a1",
        expires_in: 3600,
        refresh_token: "r1",
        id_token: fakeIdToken({ email: "Owner@Example.com", email_verified: true }),
      });
    },
  };
  await withCtx({ routes, now: NOW }, async (ctx) => {
    assertEquals(await exchangeGoogleCode(ctx, "c1"), login());
  });
});

Deno.test("saveGoogleLogin keeps the stored refresh token when Google omits one", async () => {
  await withCtx({}, async (ctx) => {
    await saveGoogleLogin(ctx, login({ refreshToken: "r-old" }));
    await saveGoogleLogin(ctx, login({ refreshToken: undefined, accessToken: "a2" }));
    assertEquals((await ctx.kv.get(["google", "tokens"])).value, {
      refreshToken: "r-old",
      accessToken: "a2",
      expiresAt: NOW + 3600_000,
    });
  });
});

Deno.test("saveGoogleLogin fails when there is no refresh token at all", async () => {
  await withCtx({}, async (ctx) => {
    await assertRejects(
      () => saveGoogleLogin(ctx, login({ refreshToken: undefined })),
      Error,
      "refresh token",
    );
  });
});

Deno.test("getAccessToken uses the cached token while fresh and refreshes when stale", async () => {
  let refreshes = 0;
  const routes: Record<string, Route> = {
    [TOKEN]: async (req) => {
      const form = new URLSearchParams(await req.text());
      assertEquals(form.get("grant_type"), "refresh_token");
      assertEquals(form.get("refresh_token"), "r1");
      refreshes++;
      return json({ access_token: "a2", expires_in: 3600 });
    },
  };
  await withCtx({ routes, now: NOW }, async (ctx) => {
    await saveGoogleLogin(ctx, login({ expiresAt: NOW + 10 * 60_000 }));
    assertEquals(await getAccessToken(ctx), "a1");
    ctx.now = () => NOW + 9.5 * 60_000; // inside the 60 s safety margin
    assertEquals(await getAccessToken(ctx), "a2");
    assertEquals(await getAccessToken(ctx), "a2");
    assertEquals(refreshes, 1);
  });
});

Deno.test("invalid_grant wipes the tokens and throws GoogleAuthExpiredError", async () => {
  const routes: Record<string, Route> = { [TOKEN]: () => json({ error: "invalid_grant" }, 400) };
  await withCtx({ routes, now: NOW }, async (ctx) => {
    await saveGoogleLogin(ctx, login({ expiresAt: NOW - 1 }));
    await assertRejects(() => getAccessToken(ctx), GoogleAuthExpiredError);
    assert(!(await hasGoogleTokens(ctx)));
  });
});

Deno.test("getAccessToken without stored tokens throws GoogleAuthExpiredError", async () => {
  await withCtx({}, async (ctx) => {
    await assertRejects(() => getAccessToken(ctx), GoogleAuthExpiredError);
  });
});
