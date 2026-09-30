import { assertEquals, assertThrows } from "@std/assert";
import { findType } from "./catalog.ts";
import {
  buildFilter,
  buildRequest,
  chooseMode,
  civilToUtc,
  parseRange,
  todayIn,
  trimResponse,
} from "./query.ts";

const type = (id: string) => findType(id)!;

Deno.test("parseRange: dates are whole local days with an inclusive 'to'", () => {
  assertEquals(parseRange("2026-09-01", "2026-09-07"), { start: "2026-09-01T00:00:00", end: "2026-09-08T00:00:00" });
  assertEquals(parseRange("2026-12-31", "2026-12-31"), { start: "2026-12-31T00:00:00", end: "2027-01-01T00:00:00" });
});

Deno.test("parseRange: datetimes are used as-is, seconds padded", () => {
  assertEquals(parseRange("2026-09-01T08:30", "2026-09-01T12:00:15"), {
    start: "2026-09-01T08:30:00",
    end: "2026-09-01T12:00:15",
  });
});

Deno.test("parseRange rejects reversed, impossible and malformed dates", () => {
  assertThrows(() => parseRange("2026-09-08", "2026-09-01"), RangeError, "must be before");
  assertThrows(() => parseRange("2026-02-30", "2026-03-01"), RangeError);
  assertThrows(() => parseRange("09/01/2026", "2026-09-02"), RangeError, "YYYY-MM-DD");
  assertThrows(() => parseRange("2026-09-01T08:00:00Z", "2026-09-02"), RangeError);
});

Deno.test("chooseMode: auto uses daily rollups for long interval ranges, merged otherwise", () => {
  const week = parseRange("2026-09-01", "2026-09-07");
  const day = parseRange("2026-09-01", "2026-09-01");
  assertEquals(chooseMode(type("steps"), "auto", week), "daily");
  assertEquals(chooseMode(type("steps"), "auto", day), "merged");
  assertEquals(chooseMode(type("weight"), "auto", week), "merged");
  assertEquals(chooseMode(type("total-calories"), "auto", day), "daily");
  assertEquals(chooseMode(type("heart-rate"), "raw", day), "raw");
  assertThrows(() => chooseMode(type("sleep"), "daily", day), RangeError, "sleep supports modes: raw, merged");
});

Deno.test("buildFilter uses snake_case ids and the right civil field per kind", () => {
  const r = parseRange("2026-09-01", "2026-09-02");
  assertEquals(
    buildFilter(type("steps"), r),
    'steps.interval.civil_start_time >= "2026-09-01T00:00:00" AND steps.interval.civil_start_time < "2026-09-03T00:00:00"',
  );
  assertEquals(
    buildFilter(type("heart-rate"), r),
    'heart_rate.sample_time.civil_time >= "2026-09-01T00:00:00" AND heart_rate.sample_time.civil_time < "2026-09-03T00:00:00"',
  );
  assertEquals(
    buildFilter(type("daily-resting-heart-rate"), r),
    'daily_resting_heart_rate.date >= "2026-09-01" AND daily_resting_heart_rate.date < "2026-09-03"',
  );
  assertEquals(
    buildFilter(type("sleep"), r),
    'sleep.interval.civil_end_time >= "2026-09-01T00:00:00" AND sleep.interval.civil_end_time < "2026-09-03T00:00:00"',
  );
  // a partial end day still includes that date for daily types
  assertEquals(
    buildFilter(type("daily-resting-heart-rate"), parseRange("2026-09-01T06:00", "2026-09-02T06:00")),
    'daily_resting_heart_rate.date >= "2026-09-01" AND daily_resting_heart_rate.date < "2026-09-03"',
  );
});

Deno.test("buildRequest: raw and merged are GETs with filter, page size and token", () => {
  const r = parseRange("2026-09-01", "2026-09-01");
  const raw = buildRequest(type("steps"), "raw", r, "UTC", "tok");
  assertEquals(raw.method, "GET");
  assertEquals(raw.path, "/v4/users/me/dataTypes/steps/dataPoints");
  assertEquals(raw.query?.pageSize, "500");
  assertEquals(raw.query?.pageToken, "tok");
  const merged = buildRequest(type("sleep"), "merged", r, "UTC");
  assertEquals(merged.path, "/v4/users/me/dataTypes/sleep/dataPoints:reconcile");
  assertEquals(merged.query?.pageSize, "25");
});

Deno.test("buildRequest: daily posts a civil range to dailyRollUp", () => {
  const req = buildRequest(type("steps"), "daily", parseRange("2026-09-01", "2026-09-02"), "UTC");
  assertEquals(req.method, "POST");
  assertEquals(req.path, "/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp");
  assertEquals(req.body, {
    range: {
      start: { date: { year: 2026, month: 9, day: 1 }, time: { hours: 0, minutes: 0, seconds: 0 } },
      end: { date: { year: 2026, month: 9, day: 3 }, time: { hours: 0, minutes: 0, seconds: 0 } },
    },
    windowSizeDays: 1,
    pageSize: 500,
  });
});

Deno.test("buildRequest: total converts local time to UTC and spans a 23 h DST day", () => {
  const req = buildRequest(type("steps"), "total", parseRange("2026-03-08", "2026-03-08"), "America/New_York");
  assertEquals(req.path, "/v4/users/me/dataTypes/steps/dataPoints:rollUp");
  assertEquals(req.body, {
    range: { startTime: "2026-03-08T05:00:00Z", endTime: "2026-03-09T04:00:00Z" },
    windowSize: "82800s",
  });
});

Deno.test("civilToUtc handles winter and summer offsets; todayIn uses the zone", () => {
  assertEquals(civilToUtc("2026-01-15T00:00:00", "America/New_York"), "2026-01-15T05:00:00Z");
  assertEquals(civilToUtc("2026-07-15T00:00:00", "America/New_York"), "2026-07-15T04:00:00Z");
  assertEquals(todayIn("America/New_York", Date.parse("2026-09-29T02:00:00Z")), "2026-09-28");
  assertEquals(todayIn("UTC", Date.parse("2026-09-29T02:00:00Z")), "2026-09-29");
});

Deno.test("trimResponse flattens the value, drops names, keeps source only in raw mode", () => {
  const body = {
    dataPoints: [{
      name: "users/1/dataTypes/body-fat/dataPoints/9",
      dataSource: { platform: "FITBIT", device: { displayName: "Charge 6" }, recordingMethod: "PASSIVELY_MEASURED" },
      bodyFat: { sampleTime: { physicalTime: "2026-03-10T10:00:00Z" }, percentage: 20 },
    }],
    nextPageToken: "next",
  };
  assertEquals(trimResponse(type("body-fat"), "raw", body), {
    points: [{
      sampleTime: { physicalTime: "2026-03-10T10:00:00Z" },
      percentage: 20,
      source: "FITBIT / Charge 6 / PASSIVELY_MEASURED",
    }],
    nextPageToken: "next",
  });
  assertEquals(trimResponse(type("body-fat"), "merged", { ...body, nextPageToken: "" }), {
    points: [{ sampleTime: { physicalTime: "2026-03-10T10:00:00Z" }, percentage: 20 }],
  });
});

Deno.test("trimResponse reads rollupDataPoints and handles empty responses", () => {
  const rollup = { rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, steps: { countSum: "8000" } }] };
  assertEquals(trimResponse(type("steps"), "daily", rollup).points, [
    { civilStartTime: { date: { year: 2026, month: 9, day: 1 } }, countSum: "8000" },
  ]);
  assertEquals(trimResponse(type("steps"), "merged", {}), { points: [] });
});
