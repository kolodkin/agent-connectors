import type { DataTypeInfo, Mode } from "./catalog.ts";

export const MAX_POINTS = 500;

/** Local (civil) times as YYYY-MM-DDTHH:mm:ss; `end` is exclusive. */
export interface CivilRange {
  start: string;
  end: string;
}

export interface ApiRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function parseRange(from: string, to: string): CivilRange {
  const start = toCivil(from, false);
  const end = toCivil(to, true);
  if (start >= end) throw new RangeError(`"from" (${from}) must be before "to" (${to})`);
  return { start, end };
}

function toCivil(value: string, isEnd: boolean): string {
  if (DATE.test(value)) {
    checkDate(value);
    return `${isEnd ? addDays(value, 1) : value}T00:00:00`;
  }
  if (DATETIME.test(value)) {
    checkDate(value.slice(0, 10));
    return value.length === 16 ? `${value}:00` : value;
  }
  throw new RangeError(`Invalid date "${value}": use YYYY-MM-DD or YYYY-MM-DDTHH:mm in your local time`);
}

function checkDate(date: string): void {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Invalid date "${date}"`);
  }
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayIn(tz: string, nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(nowMs));
}

/** Converts a local time in `tz` to an RFC 3339 UTC timestamp. */
export function civilToUtc(civil: string, tz: string): string {
  const naive = Date.parse(`${civil}Z`);
  // Two passes so the offset is taken at the resulting instant (correct across DST changes).
  let ts = naive - tzOffsetMs(naive, tz);
  ts = naive - tzOffsetMs(ts, tz);
  return new Date(ts).toISOString().replace(".000Z", "Z");
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function rangeDays(r: CivilRange): number {
  return (Date.parse(`${r.end}Z`) - Date.parse(`${r.start}Z`)) / 86_400_000;
}

export function chooseMode(info: DataTypeInfo, requested: Mode | "auto", range: CivilRange): Mode {
  if (requested !== "auto") {
    if (!info.modes.includes(requested)) {
      throw new RangeError(`${info.id} supports modes: ${info.modes.join(", ")}`);
    }
    return requested;
  }
  if (!info.modes.includes("merged")) return info.modes.includes("daily") ? "daily" : info.modes[0];
  if (info.kind === "interval" && info.modes.includes("daily") && rangeDays(range) > 2) return "daily";
  return "merged";
}

const FILTER_FIELD = {
  civil_start: "interval.civil_start_time",
  civil_end: "interval.civil_end_time",
  civil_sample: "sample_time.civil_time",
} as const;

export function buildFilter(info: DataTypeInfo, r: CivilRange): string {
  const name = info.id.replaceAll("-", "_"); // filters use snake_case ids
  if (info.filter === "date") {
    const endDate = r.end.endsWith("T00:00:00") ? r.end.slice(0, 10) : addDays(r.end.slice(0, 10), 1);
    return `${name}.date >= "${r.start.slice(0, 10)}" AND ${name}.date < "${endDate}"`;
  }
  const field = `${name}.${FILTER_FIELD[info.filter]}`;
  return `${field} >= "${r.start}" AND ${field} < "${r.end}"`;
}

export function buildRequest(
  info: DataTypeInfo,
  mode: Mode,
  r: CivilRange,
  tz: string,
  pageToken?: string,
): ApiRequest {
  const path = `/v4/users/me/dataTypes/${info.id}/dataPoints`;
  const page: Record<string, string> = pageToken ? { pageToken } : {};
  switch (mode) {
    case "raw":
    case "merged":
      return {
        method: "GET",
        path: mode === "raw" ? path : `${path}:reconcile`,
        query: { filter: buildFilter(info, r), pageSize: String(info.maxPageSize ?? MAX_POINTS), ...page },
      };
    case "daily":
      return {
        method: "POST",
        path: `${path}:dailyRollUp`,
        body: {
          range: { start: civilDateTime(r.start), end: civilDateTime(r.end) },
          windowSizeDays: 1,
          pageSize: MAX_POINTS,
          ...page,
        },
      };
    case "total": {
      const startTime = civilToUtc(r.start, tz);
      const endTime = civilToUtc(r.end, tz);
      const seconds = (Date.parse(endTime) - Date.parse(startTime)) / 1000;
      return {
        method: "POST",
        path: `${path}:rollUp`,
        body: { range: { startTime, endTime }, windowSize: `${seconds}s`, ...page },
      };
    }
  }
}

function civilDateTime(civil: string) {
  const [year, month, day] = civil.slice(0, 10).split("-").map(Number);
  const [hours, minutes, seconds] = civil.slice(11).split(":").map(Number);
  return { date: { year, month, day }, time: { hours, minutes, seconds } };
}

type Json = Record<string, unknown>;

/** Keeps what a chat model needs: the value fields and times; device source only in raw mode. */
export function trimResponse(info: DataTypeInfo, mode: Mode, body: Json): { points: Json[]; nextPageToken?: string } {
  const raw = (body.dataPoints ?? body.rollupDataPoints ?? []) as Json[];
  const valueKey = info.id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()); // body-fat → bodyFat
  const points = raw.map((p) => {
    const { name: _name, dataPointName: _dpName, dataSource, [valueKey]: value, ...rest } = p;
    const out: Json = { ...rest, ...(isObject(value) ? value : value === undefined ? {} : { value }) };
    if (mode === "raw" && isObject(dataSource)) out.source = describeSource(dataSource);
    return out;
  });
  const next = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
  return next ? { points, nextPageToken: next } : { points };
}

function describeSource(s: Json): string {
  const device = isObject(s.device) ? s.device.displayName : undefined;
  return [s.platform, device, s.recordingMethod].filter(Boolean).join(" / ");
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
