import type { Config } from "./config.ts";

/** Everything with side effects, injected so tests run offline. */
export interface Ctx {
  config: Config;
  kv: Deno.Kv;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
