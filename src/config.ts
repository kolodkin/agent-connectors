export interface Config {
  googleClientId: string;
  googleClientSecret: string;
  allowedEmail: string;
  baseUrl: string;
  tz: string;
}

const REQUIRED = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAIL", "BASE_URL"];

export function loadConfig(env: (name: string) => string | undefined): Config {
  const missing = REQUIRED.filter((name) => !env(name));
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  const tz = env("TZ") || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Invalid TZ: ${tz}`);
  }
  return {
    googleClientId: env("GOOGLE_CLIENT_ID")!,
    googleClientSecret: env("GOOGLE_CLIENT_SECRET")!,
    allowedEmail: env("ALLOWED_EMAIL")!.toLowerCase(),
    baseUrl: env("BASE_URL")!.replace(/\/+$/, ""),
    tz,
  };
}
