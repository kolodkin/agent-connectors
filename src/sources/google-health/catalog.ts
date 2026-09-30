// Readable Google Health API data types (https://developers.google.com/health/data-types).
// The API has no discovery endpoint, so this list is maintained by hand.

export type Kind = "interval" | "sample" | "daily" | "session";
export type Mode = "raw" | "merged" | "daily" | "total";
export type Category = "activity" | "body" | "heart" | "sleep" | "logs";
/** Field used by list/reconcile filters. All are civil (local) times. */
export type FilterField = "civil_start" | "civil_end" | "civil_sample" | "date";

export interface DataTypeInfo {
  id: string;
  kind: Kind;
  category: Category;
  modes: Mode[];
  filter: FilterField;
  scope: string;
  maxPageSize?: number;
}

const G = "https://www.googleapis.com/auth/googlehealth.";
export const SCOPE = {
  activity: `${G}activity_and_fitness.readonly`,
  metrics: `${G}health_metrics_and_measurements.readonly`,
  sleep: `${G}sleep.readonly`,
  nutrition: `${G}nutrition.readonly`,
} as const;
export const SCOPES: string[] = Object.values(SCOPE);

const CATEGORY_SCOPE: Record<Category, string> = {
  activity: SCOPE.activity,
  body: SCOPE.metrics,
  heart: SCOPE.metrics,
  sleep: SCOPE.sleep,
  logs: SCOPE.nutrition,
};

const ALL: Mode[] = ["raw", "merged", "daily", "total"];
const POINTS: Mode[] = ["raw", "merged"];
const ROLLUP: Mode[] = ["daily", "total"];

function t(id: string, kind: Kind, category: Category, modes: Mode[], extra: Partial<DataTypeInfo> = {}): DataTypeInfo {
  const filter: FilterField = kind === "sample" ? "civil_sample" : kind === "daily" ? "date" : "civil_start";
  return { id, kind, category, modes, filter, scope: CATEGORY_SCOPE[category], ...extra };
}

export const CATALOG: DataTypeInfo[] = [
  // activity
  t("steps", "interval", "activity", ALL),
  t("distance", "interval", "activity", ALL),
  t("active-energy-burned", "interval", "activity", ALL),
  t("active-minutes", "interval", "activity", ALL),
  t("active-zone-minutes", "interval", "activity", ALL),
  t("altitude", "interval", "activity", ALL),
  t("sedentary-period", "interval", "activity", ALL),
  t("swim-lengths-data", "interval", "activity", ALL),
  t("time-in-heart-rate-zone", "interval", "activity", ALL),
  t("activity-level", "interval", "activity", POINTS),
  t("floors", "interval", "activity", ["merged", "daily", "total"]),
  t("total-calories", "interval", "activity", ROLLUP),
  t("calories-in-heart-rate-zone", "interval", "activity", ROLLUP),
  t("exercise", "session", "activity", POINTS, { maxPageSize: 25 }),
  t("vo2-max", "sample", "activity", POINTS),
  t("run-vo2-max", "sample", "activity", ALL),
  t("daily-vo2-max", "daily", "activity", POINTS),
  // body
  t("weight", "sample", "body", ALL),
  t("body-fat", "sample", "body", ALL),
  t("height", "sample", "body", POINTS),
  t("blood-glucose", "sample", "body", ALL),
  t("core-body-temperature", "sample", "body", ALL),
  // heart
  t("heart-rate", "sample", "heart", ALL),
  t("heart-rate-variability", "sample", "heart", POINTS),
  t("oxygen-saturation", "sample", "heart", POINTS),
  t("daily-resting-heart-rate", "daily", "heart", POINTS),
  t("daily-heart-rate-variability", "daily", "heart", POINTS),
  t("daily-heart-rate-zones", "daily", "heart", POINTS),
  t("daily-oxygen-saturation", "daily", "heart", POINTS),
  t("daily-respiratory-rate", "daily", "heart", POINTS),
  // sleep
  t("sleep", "session", "sleep", POINTS, { filter: "civil_end", maxPageSize: 25 }),
  t("respiratory-rate-sleep-summary", "sample", "sleep", POINTS, { scope: SCOPE.metrics }),
  t("daily-sleep-temperature-derivations", "daily", "sleep", POINTS, { scope: SCOPE.metrics }),
  // logs
  t("hydration-log", "session", "logs", ALL),
];

export function findType(id: string): DataTypeInfo | undefined {
  return CATALOG.find((info) => info.id === id);
}
