import { createHandler } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig((name) => Deno.env.get(name));
const kv = await Deno.openKv();

Deno.serve(createHandler({
  config,
  kv,
  fetch: globalThis.fetch.bind(globalThis),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
