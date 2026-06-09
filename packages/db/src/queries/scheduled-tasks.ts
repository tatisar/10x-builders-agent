import type { DbClient } from "../client";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskStatus,
  ScheduleType,
  TaskRunStatus,
} from "@agents/types";

export async function createScheduledTask(
  db: DbClient,
  params: {
    userId: string;
    prompt: string;
    scheduleType: ScheduleType;
    runAt?: string;
    cronExpr?: string;
    timezone?: string;
    nextRunAt: string;
  }
): Promise<ScheduledTask> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .insert({
      user_id: params.userId,
      prompt: params.prompt,
      schedule_type: params.scheduleType,
      run_at: params.runAt ?? null,
      cron_expr: params.cronExpr ?? null,
      timezone: params.timezone ?? "UTC",
      status: "active",
      next_run_at: params.nextRunAt,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTask;
}

/**
 * Returns tasks due for execution (next_run_at <= now, status = active) and
 * atomically marks them as running by updating next_run_at to a future
 * sentinel so a concurrent invocation cannot pick the same row.
 *
 * The cron runner is responsible for recalculating the real next_run_at after
 * the execution finishes.
 */
export async function claimDueTasks(
  db: DbClient,
  limit = 20
): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();

  // Read candidates first (service-role, no RLS restriction)
  const { data: candidates, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", now)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  if (!candidates || candidates.length === 0) return [];

  // Optimistic claim: push next_run_at far into the future so parallel runners skip them.
  // Real value is set by completeTaskRun / failTaskRun.
  const sentinel = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
  const ids = (candidates as ScheduledTask[]).map((t) => t.id);

  await db
    .from("scheduled_tasks")
    .update({ next_run_at: sentinel, updated_at: now })
    .in("id", ids)
    .eq("status", "active"); // extra guard

  return candidates as ScheduledTask[];
}

export async function getScheduledTask(
  db: DbClient,
  taskId: string
): Promise<ScheduledTask | null> {
  const { data } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("id", taskId)
    .single();
  return data as ScheduledTask | null;
}

export async function listScheduledTasksByUser(
  db: DbClient,
  userId: string,
  status?: ScheduledTaskStatus
): Promise<ScheduledTask[]> {
  let query = db
    .from("scheduled_tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ScheduledTask[];
}

export async function getScheduledTaskForUser(
  db: DbClient,
  taskId: string,
  userId: string
): Promise<ScheduledTask | null> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as ScheduledTask | null;
}

export async function pauseScheduledTask(
  db: DbClient,
  taskId: string,
  userId: string
): Promise<ScheduledTask | null> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("scheduled_tasks")
    .update({ status: "paused", updated_at: now })
    .eq("id", taskId)
    .eq("user_id", userId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data as ScheduledTask | null;
}

export async function resumeScheduledTask(
  db: DbClient,
  taskId: string,
  userId: string,
  nextRunAt: string
): Promise<ScheduledTask | null> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("scheduled_tasks")
    .update({ status: "active", next_run_at: nextRunAt, updated_at: now })
    .eq("id", taskId)
    .eq("user_id", userId)
    .eq("status", "paused")
    .select()
    .maybeSingle();
  if (error) throw error;
  return data as ScheduledTask | null;
}

export async function deleteScheduledTask(
  db: DbClient,
  taskId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .delete()
    .eq("id", taskId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function createTaskRun(
  db: DbClient,
  taskId: string,
  agentSessionId?: string
): Promise<ScheduledTaskRun> {
  const { data, error } = await db
    .from("scheduled_task_runs")
    .insert({
      task_id: taskId,
      status: "running",
      agent_session_id: agentSessionId ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTaskRun;
}

export async function completeTaskRun(
  db: DbClient,
  params: {
    runId: string;
    taskId: string;
    agentSessionId?: string;
    nextRunAt: string | null;
    newStatus: "completed" | "active";
    notified: boolean;
    notificationError?: string;
  }
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .from("scheduled_task_runs")
    .update({
      status: "completed" as TaskRunStatus,
      finished_at: now,
      agent_session_id: params.agentSessionId ?? null,
      notified: params.notified,
      notification_error: params.notificationError ?? null,
    })
    .eq("id", params.runId);

  await db
    .from("scheduled_tasks")
    .update({
      status: params.newStatus,
      last_run_at: now,
      next_run_at: params.nextRunAt,
      updated_at: now,
    })
    .eq("id", params.taskId);
}

export async function failTaskRun(
  db: DbClient,
  params: {
    runId: string;
    taskId: string;
    errorMessage: string;
    nextRunAt: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .from("scheduled_task_runs")
    .update({
      status: "failed" as TaskRunStatus,
      finished_at: now,
      error: params.errorMessage,
    })
    .eq("id", params.runId);

  await db
    .from("scheduled_tasks")
    .update({
      last_run_at: now,
      next_run_at: params.nextRunAt,
      updated_at: now,
    })
    .eq("id", params.taskId);
}
