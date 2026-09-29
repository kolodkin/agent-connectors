import { assert, assertEquals } from "@std/assert";
import { CATALOG, findType, SCOPE, SCOPES } from "./catalog.ts";

Deno.test("catalogue ids are unique and every type has at least one mode", () => {
  assertEquals(new Set(CATALOG.map((t) => t.id)).size, CATALOG.length);
  assert(CATALOG.every((t) => t.modes.length > 0));
});

Deno.test("rollup-only types cannot be listed raw", () => {
  for (const id of ["floors", "total-calories", "calories-in-heart-rate-zone"]) {
    assertEquals(findType(id)?.modes.includes("raw"), false, id);
  }
});

Deno.test("scopes follow the data type, not just the category", () => {
  assertEquals(findType("sleep")?.scope, SCOPE.sleep);
  assertEquals(findType("respiratory-rate-sleep-summary")?.scope, SCOPE.metrics);
  assertEquals(findType("hydration-log")?.scope, SCOPE.nutrition);
  assertEquals(findType("steps")?.scope, SCOPE.activity);
  assert(CATALOG.every((t) => SCOPES.includes(t.scope)));
});

Deno.test("sleep filters on civil end time; exercise and sleep cap pages at 25", () => {
  assertEquals(findType("sleep")?.filter, "civil_end");
  assertEquals(findType("exercise")?.filter, "civil_start");
  assertEquals(findType("sleep")?.maxPageSize, 25);
  assertEquals(findType("exercise")?.maxPageSize, 25);
});
