import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

let _saver: PostgresSaver | null = null;

/**
 * Returns a singleton PostgresSaver backed by DATABASE_URL.
 * On first call, creates the LangGraph checkpoint tables (idempotent).
 *
 * Use Supabase Session pooler (port 5432) when the direct db.* host is
 * unreachable (IPv6-only). Avoid transaction pooler (port 6543).
 */
export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!_saver) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required for LangGraph checkpointing");
    }
    _saver = PostgresSaver.fromConnString(url);
    try {
      await _saver.setup();
    } catch (error) {
      _saver = null;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOTFOUND") && url.includes("db.") && url.includes(".supabase.co")) {
        throw new Error(
          "Cannot reach Supabase direct database host (IPv6-only). " +
            "Set DATABASE_URL to the Session pooler URI from Supabase Connect (port 5432, user postgres.[project-ref])."
        );
      }
      throw error;
    }
  }
  return _saver;
}
