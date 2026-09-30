import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Ctx } from "../../ctx.ts";
import { GOOGLE_TOKEN_URL, GoogleAuthExpiredError, saveGoogleLogin } from "../../google/oauth.ts";
import { json, ownerLogin, type Route, withCtx } from "../../testing.ts";
import { HEALTH_API } from "./client.ts";
import { getDailySummary, getHealthData, listDataTypes } from "./tools.ts";

const API = `${HEALTH_API}/v4/users/me/dataTypes`;

async function withHealth(routes: Record<string, Route>, fn: (ctx: Ctx, calls: Request[]) => Promise<void>) {
  await withCtx({ routes }, async (ctx, calls) => {
    await saveGoogleLogin(ctx, ownerLogin({ accessToken: "ga" }));
    await fn(ctx, calls);
  });
}

Deno.test("listDataTypes groups the catalogue by category", () => {
  const { categories, modes } = listDataTypes();
  assert(categories.activity.some((t) => t.id === "steps"));
  assert(categories.sleep.some((t) => t.id === "sleep"));
  assertEquals(Object.keys(modes).sort(), ["daily", "merged", "raw", "total"]);
});

Deno.test("a week of steps uses dailyRollUp with the Google token and returns trimmed points", async () => {
  const routes = {
    [`POST ${API}/steps/dataPoints:dailyRollUp`]: async (req: Request) => {
      assertEquals(req.headers.get("authorization"), "Bearer ga");
      assertEquals((await req.json()).windowSizeDays, 1);
      return json({ rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, steps: { countSum: "8000" } }] });
    },
  };
  await withHealth(routes, async (ctx) => {
    const res = await getHealthData(ctx, { type: "steps", from: "2026-09-01", to: "2026-09-07" });
    assertEquals(res.mode, "daily");
    assertEquals(res.points, [{ civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, countSum: "8000" }]);
  });
});

Deno.test("weight uses reconcile with a civil filter; empty results carry a note", async () => {
  const routes = {
    [`GET ${API}/weight/dataPoints:reconcile`]: (req: Request) => {
      assertStringIncludes(new URL(req.url).searchParams.get("filter")!, 'weight.sample_time.civil_time >= "2026-09-01T00:00:00"');
      return json({ dataPoints: [] });
    },
  };
  await withHealth(routes, async (ctx) => {
    const res = await getHealthData(ctx, { type: "weight", from: "2026-09-01", to: "2026-09-01" });
    assertEquals(res.points, []);
    assertEquals(res.note, "No weight data in this range");
  });
});

Deno.test("bad input fails before any Google call", async () => {
  await withHealth({}, async (ctx, calls) => {
    await assertRejects(() => getHealthData(ctx, { type: "mood", from: "2026-09-01", to: "2026-09-02" }), RangeError, "list_data_types");
    await assertRejects(() => getHealthData(ctx, { type: "steps", from: "2026-09-08", to: "2026-09-01" }), RangeError, "must be before");
    await assertRejects(() => getHealthData(ctx, { type: "sleep", from: "2026-09-01", to: "2026-09-02", mode: "total" }), RangeError, "supports modes");
    assertEquals(calls.length, 0);
  });
});

Deno.test("a 403 names the scope the type needs", async () => {
  const routes = { [`GET ${API}/sleep/dataPoints:reconcile`]: () => json({ error: { status: "PERMISSION_DENIED" } }, 403) };
  await withHealth(routes, async (ctx) => {
    await assertRejects(
      () => getHealthData(ctx, { type: "sleep", from: "2026-09-01", to: "2026-09-01" }),
      Error,
      "googlehealth.sleep.readonly",
    );
  });
});

Deno.test("429 and 5xx are retried once", async () => {
  let n = 0;
  const flaky = { [`GET ${API}/weight/dataPoints:reconcile`]: () => (++n === 1 ? json({}, 429) : json({ dataPoints: [] })) };
  await withHealth(flaky, async (ctx) => {
    await getHealthData(ctx, { type: "weight", from: "2026-09-01", to: "2026-09-01" });
    assertEquals(n, 2);
  });
  const down = { [`GET ${API}/weight/dataPoints:reconcile`]: () => json({}, 503) };
  await withHealth(down, async (ctx, calls) => {
    await assertRejects(() => getHealthData(ctx, { type: "weight", from: "2026-09-01", to: "2026-09-01" }), Error, "503");
    assertEquals(calls.length, 2);
  });
});

Deno.test("daily summary collects metrics, lists missing ones, and isolates failures", async () => {
  const empty = () => json({ dataPoints: [] });
  const routes: Record<string, Route> = {
    [`POST ${API}/steps/dataPoints:dailyRollUp`]: () => json({ rollupDataPoints: [{ steps: { countSum: "8000" } }] }),
    [`POST ${API}/distance/dataPoints:dailyRollUp`]: () => json({ rollupDataPoints: [] }),
    [`GET ${API}/exercise/dataPoints:reconcile`]: empty,
    [`GET ${API}/sleep/dataPoints:reconcile`]: (req) => {
      assertStringIncludes(new URL(req.url).searchParams.get("filter")!, "sleep.interval.civil_end_time");
      return json({ dataPoints: [{ sleep: { interval: { civilEndTime: "x" } } }] });
    },
    [`GET ${API}/daily-resting-heart-rate/dataPoints:reconcile`]: () => json({}, 500),
    [`GET ${API}/daily-heart-rate-variability/dataPoints:reconcile`]: empty,
    [`GET ${API}/weight/dataPoints:reconcile`]: () =>
      json({ dataPoints: [{ weight: { kilograms: 80 } }, { weight: { kilograms: 81 } }] }),
    [`POST ${API}/hydration-log/dataPoints:dailyRollUp`]: () => json({ rollupDataPoints: [] }),
  };
  await withHealth(routes, async (ctx) => {
    const res = await getDailySummary(ctx, "2026-09-28");
    assertEquals(res.date, "2026-09-28");
    assertEquals(res.summary.steps, { countSum: "8000" });
    assertEquals(res.summary.weight, { kilograms: 80 }); // latest only
    assertEquals(res.summary.sleep, { interval: { civilEndTime: "x" } });
    assertEquals(res.missing.sort(), ["daily-heart-rate-variability", "distance", "exercise", "hydration-log"]);
    assertStringIncludes(res.errors!["daily-resting-heart-rate"], "500");
  });
});

Deno.test("daily summary defaults to today in TZ", async () => {
  const empty = () => json({ dataPoints: [], rollupDataPoints: [] });
  const routes: Record<string, Route> = {};
  for (const [method, id, suffix] of [
    ["POST", "steps", "dailyRollUp"], ["POST", "distance", "dailyRollUp"], ["GET", "exercise", "reconcile"],
    ["GET", "sleep", "reconcile"], ["GET", "daily-resting-heart-rate", "reconcile"],
    ["GET", "daily-heart-rate-variability", "reconcile"], ["GET", "weight", "reconcile"],
    ["POST", "hydration-log", "dailyRollUp"],
  ]) routes[`${method} ${API}/${id}/dataPoints:${suffix}`] = empty;
  await withHealth(routes, async (ctx) => {
    ctx.now = () => Date.parse("2026-09-29T02:00:00Z"); // still Sept 28 in New York
    assertEquals((await getDailySummary(ctx)).date, "2026-09-28");
  });
});

Deno.test("expired Google access fails the whole summary with the reconnect message", async () => {
  const routes = { [`POST ${GOOGLE_TOKEN_URL}`]: () => json({ error: "invalid_grant" }, 400) };
  await withCtx({ routes }, async (ctx) => {
    await saveGoogleLogin(ctx, ownerLogin({ expiresAt: 0 }));
    await assertRejects(() => getDailySummary(ctx, "2026-09-28"), GoogleAuthExpiredError, "reconnect");
  });
});
