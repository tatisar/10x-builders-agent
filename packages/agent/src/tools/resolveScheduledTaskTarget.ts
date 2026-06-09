import type { DbClient } from "@agents/db";
import type { ScheduledTask, ScheduledTaskStatus } from "@agents/types";

export type ResolveTaskInput = { task_id?: string; prompt_match?: string };

export type ResolveTaskResult =
  | { ok: true; task: ScheduledTask }
  | { ok: false; error: { code: string; message: string }; candidates?: string[] };

export async function resolveScheduledTaskTarget(
  db: DbClient,
  userId: string,
  input: ResolveTaskInput,
  searchStatuses: ScheduledTaskStatus[],
  getScheduledTaskForUser: (
    db: DbClient,
    taskId: string,
    userId: string
  ) => Promise<ScheduledTask | null>,
  listScheduledTasksByUser: (
    db: DbClient,
    userId: string,
    status?: ScheduledTaskStatus
  ) => Promise<ScheduledTask[]>
): Promise<ResolveTaskResult> {
  if (input.task_id) {
    const task = await getScheduledTaskForUser(db, input.task_id, userId);
    if (!task) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Task not found: ${input.task_id}` },
      };
    }
    return { ok: true, task };
  }

  if (!input.prompt_match) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Either task_id or prompt_match is required.",
      },
    };
  }

  const needle = input.prompt_match.toLowerCase();
  const lists = await Promise.all(
    searchStatuses.map((status) => listScheduledTasksByUser(db, userId, status))
  );
  const matches = lists.flat().filter((t) => t.prompt.toLowerCase().includes(needle));

  if (matches.length === 0) {
    const statusLabel = searchStatuses.join(" or ");
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `No ${statusLabel} task found matching prompt "${input.prompt_match}".`,
      },
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: "AMBIGUOUS",
        message: `Multiple tasks (${matches.length}) match "${input.prompt_match}". Use task_id from list_scheduled_tasks.`,
      },
      candidates: matches.map((t) => t.id),
    };
  }

  return { ok: true, task: matches[0]! };
}
