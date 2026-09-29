import { z } from "zod";
import type { Ctx } from "../../ctx.ts";
import { GoogleAuthExpiredError } from "../../google/oauth.ts";
import type { McpServer } from "../../sdk.ts";
import { CATALOG, findType, type Mode } from "./catalog.ts";
import { HealthApiError, healthRequest } from "./client.ts";
import { buildRequest, chooseMode, parseRange, todayIn, trimResponse } from "./query.ts";

export interface HealthDataInput {
  type: string;
  from: string;
  to: string;
  mode?: Mode | "auto";
  pageToken?: string;
}

const MODE_HELP: Record<Mode, string> = {
  raw: "individual points with the device that recorded them",
  merged: "points deduplicated across devices",
  daily: "one total per day",
  total: "one total for the whole range",
};

export function listDataTypes() {
  const categories: Record<string, { id: string; kind: string; modes: Mode[] }[]> = {};
  for (const t of CATALOG) (categories[t.category] ??= []).push({ id: t.id, kind: t.kind, modes: t.modes });
  return { categories, modes: MODE_HELP };
}

export async function getHealthData(ctx: Ctx, input: HealthDataInput) {
  const info = findType(input.type);
  if (!info) throw new RangeError(`Unknown type "${input.type}". Call list_data_types to see valid types.`);
  const range = parseRange(input.from, input.to);
  const mode = chooseMode(info, input.mode ?? "auto", range);
  let body: Record<string, unknown>;
  try {
    body = await healthRequest(ctx, buildRequest(info, mode, range, ctx.config.tz, input.pageToken));
  } catch (e) {
    if (e instanceof HealthApiError && e.status === 403) {
      throw new HealthApiError(403, `Google denied access to ${info.id}; it needs scope ${info.scope}. Reconnect and grant it. (${e.message})`);
    }
    throw e;
  }
  const { points, nextPageToken } = trimResponse(info, mode, body);
  return {
    type: info.id,
    mode,
    from: input.from,
    to: input.to,
    points,
    ...(nextPageToken ? { nextPageToken } : {}),
    ...(points.length ? {} : { note: `No ${info.id} data in this range` }),
  };
}

const SUMMARY: { type: string; mode: Mode; latestOnly?: boolean }[] = [
  { type: "steps", mode: "daily" },
  { type: "distance", mode: "daily" },
  { type: "exercise", mode: "merged" },
  { type: "sleep", mode: "merged" }, // filters on end time: the night ending on this date
  { type: "daily-resting-heart-rate", mode: "merged" },
  { type: "daily-heart-rate-variability", mode: "merged" },
  { type: "weight", mode: "merged", latestOnly: true }, // points are newest first
  { type: "hydration-log", mode: "daily" },
];

export async function getDailySummary(ctx: Ctx, date?: string) {
  const day = date ?? todayIn(ctx.config.tz, ctx.now());
  const results = await Promise.allSettled(
    SUMMARY.map((m) => getHealthData(ctx, { type: m.type, from: day, to: day, mode: m.mode })),
  );
  const summary: Record<string, unknown> = {};
  const missing: string[] = [];
  const errors: Record<string, string> = {};
  for (const [i, r] of results.entries()) {
    const { type, latestOnly } = SUMMARY[i];
    if (r.status === "rejected") {
      if (r.reason instanceof GoogleAuthExpiredError) throw r.reason;
      errors[type] = r.reason instanceof Error ? r.reason.message : String(r.reason);
    } else if (r.value.points.length === 0) {
      missing.push(type);
    } else {
      summary[type] = latestOnly || r.value.points.length === 1 ? r.value.points[0] : r.value.points;
    }
  }
  return { date: day, summary, missing, ...(Object.keys(errors).length ? { errors } : {}) };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

const DATE_HELP = "YYYY-MM-DD or YYYY-MM-DDTHH:mm, in the owner's local time";

export function registerTools(server: McpServer, ctx: Ctx): void {
  server.registerTool("list_data_types", {
    title: "List health data types",
    description:
      "Lists the Google Health data types this connector can read, grouped by category, with the read modes each supports. Call this first if unsure which type to query.",
    annotations: { readOnlyHint: true },
  }, () => ok(listDataTypes()));

  server.registerTool("get_health_data", {
    title: "Get health data",
    description:
      "Reads one Google Health data type over a date range. 'to' dates are inclusive. mode: auto (default: daily totals for multi-day activity ranges, otherwise merged points), raw, merged, daily, total. Large results return nextPageToken.",
    inputSchema: {
      type: z.string().describe("Data type id from list_data_types, e.g. steps, weight, sleep, heart-rate"),
      from: z.string().describe(`Start: ${DATE_HELP}`),
      to: z.string().describe(`End (inclusive for dates): ${DATE_HELP}`),
      mode: z.enum(["auto", "raw", "merged", "daily", "total"]).optional(),
      pageToken: z.string().optional().describe("nextPageToken from a previous call"),
    },
    annotations: { readOnlyHint: true },
  }, (args) => run(() => getHealthData(ctx, args)));

  server.registerTool("get_daily_summary", {
    title: "Get daily health summary",
    description:
      "One-call overview of a day: steps, distance, exercise, last night's sleep, resting heart rate, HRV, weight and hydration. Lists metrics with no data under 'missing'.",
    inputSchema: {
      date: z.string().optional().describe("YYYY-MM-DD; defaults to today in the owner's timezone"),
    },
    annotations: { readOnlyHint: true },
  }, ({ date }) => run(() => getDailySummary(ctx, date)));
}
