import { Cron } from "croner";
import type { ScheduledTask } from "@agents/types";

export type NextRunResult =
  | { ok: true; nextRunAt: string }
  | { ok: false; code: string; message: string };

/** Computes next_run_at when resuming a paused task (validates one_time run_at is still in the future). */
export function computeNextRunAtForResume(task: ScheduledTask): NextRunResult {
  if (task.schedule_type === "recurring") {
    if (!task.cron_expr) {
      return { ok: false, code: "INVALID_TASK", message: "Recurring task is missing cron_expr." };
    }
    try {
      const job = new Cron(task.cron_expr, { timezone: task.timezone });
      const next = job.nextRun();
      if (!next) {
        return {
          ok: false,
          code: "INVALID_CRON",
          message: "Could not compute next run from cron expression.",
        };
      }
      return { ok: true, nextRunAt: next.toISOString() };
    } catch {
      return { ok: false, code: "INVALID_CRON", message: "Invalid cron expression." };
    }
  }

  if (!task.run_at) {
    return { ok: false, code: "INVALID_TASK", message: "One-time task is missing run_at." };
  }

  const runAt = new Date(task.run_at);
  if (runAt.getTime() <= Date.now()) {
    return {
      ok: false,
      code: "RUN_AT_PAST",
      message:
        "The scheduled run_at is in the past. Create a new task with schedule_task instead.",
    };
  }

  return { ok: true, nextRunAt: runAt.toISOString() };
}

/** Computes next_run_at after a cron execution (null for completed one_time tasks). */
export function computeNextRunAtAfterRun(task: ScheduledTask): string | null {
  if (task.schedule_type === "one_time") return null;
  if (!task.cron_expr) return null;
  try {
    const job = new Cron(task.cron_expr, { timezone: task.timezone });
    const next = job.nextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}
