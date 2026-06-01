const AGENT_ENV_HINT =
  "Set these in apps/web/.env.local (see .env.example). " +
  "DATABASE_URL: Supabase Connect → Session, port 5432. " +
  "Use the pooler host (aws-*-REGION.pooler.supabase.com) if db.*.supabase.co fails with ENOTFOUND (IPv4-only network).";

export function getDatabaseUrlHint(url: string): string | null {
  try {
    const { hostname, port, username } = new URL(url);
    if (hostname.startsWith("db.") && hostname.endsWith(".supabase.co")) {
      return (
        "DATABASE_URL uses the direct host (db.*.supabase.co), which is IPv6-only. " +
        "On many networks it fails with ENOTFOUND. Use Supabase Connect → Session (port 5432): " +
        "postgresql://postgres.[project-ref]:[password]@aws-[n]-[region].pooler.supabase.com:5432/postgres"
      );
    }
    if (port === "6543") {
      return "DATABASE_URL uses port 6543 (transaction pooler). Use Session mode on port 5432 instead.";
    }
    if (username === "postgres" && hostname.includes("pooler.supabase.com")) {
      return "Session pooler username must be postgres.[project-ref], not postgres.";
    }
  } catch {
    return "DATABASE_URL is not a valid PostgreSQL connection URI.";
  }
  return null;
}

export function getAgentEnvError(): string | null {
  const missing: string[] = [];
  if (!process.env.OPENROUTER_API_KEY?.trim()) missing.push("OPENROUTER_API_KEY");
  if (!process.env.DATABASE_URL?.trim()) missing.push("DATABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (missing.length === 0) {
    const urlHint = getDatabaseUrlHint(process.env.DATABASE_URL!.trim());
    if (urlHint) return urlHint;
    return null;
  }
  return `Missing required environment variable(s): ${missing.join(", ")}. ${AGENT_ENV_HINT}`;
}
