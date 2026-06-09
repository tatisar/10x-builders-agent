import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { ScheduledTaskStatus, UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG } from "@agents/types";
import { TOOL_SCHEMAS } from "./schemas";
import { withTracking } from "./withTracking";
import { executeBash } from "./bashExec";
import { executeReadFile, executeWriteFile, executeEditFile } from "./fileTools";
import { executeFetchUrl } from "./fetchUrl";
import { resolveScheduledTaskTarget } from "./resolveScheduledTaskTarget";
import { computeNextRunAtForResume } from "./scheduledTaskUtils";

const GITHUB_API = "https://api.github.com";
const GITHUB_UA = "10x-builders-agent/1.0";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
}

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": GITHUB_UA,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...ghHeaders(token), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json();
}

export async function executeGitHubTool(
  toolName: string,
  args: Record<string, unknown>,
  token: string
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case "github_list_repos": {
      const perPage = (args.per_page as number) || 10;
      const repos = await ghFetch(token, `/user/repos?per_page=${perPage}&sort=updated`);
      return {
        repos: (repos as Array<Record<string, unknown>>).map((r) => ({
          full_name: r.full_name,
          description: r.description,
          html_url: r.html_url,
          private: r.private,
          language: r.language,
          updated_at: r.updated_at,
        })),
      };
    }
    case "github_list_issues": {
      const state = (args.state as string) || "open";
      const issues = await ghFetch(
        token,
        `/repos/${args.owner}/${args.repo}/issues?state=${state}`
      );
      return {
        issues: (issues as Array<Record<string, unknown>>).map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          html_url: i.html_url,
          created_at: i.created_at,
          user: (i.user as Record<string, unknown>)?.login,
        })),
      };
    }
    case "github_create_issue": {
      const issue = await ghFetch(
        token,
        `/repos/${args.owner}/${args.repo}/issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: args.title, body: args.body ?? "" }),
        }
      );
      return {
        message: "Issue created",
        issue_number: (issue as Record<string, unknown>).number,
        issue_url: (issue as Record<string, unknown>).html_url,
      };
    }
    case "github_create_repo": {
      const repo = await ghFetch(token, "/user/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: args.name,
          description: args.description ?? "",
          private: args.isPrivate ?? false,
        }),
      });
      return {
        message: "Repository created",
        full_name: (repo as Record<string, unknown>).full_name,
        html_url: (repo as Record<string, unknown>).html_url,
      };
    }
    default:
      throw new Error(`Unknown GitHub tool: ${toolName}`);
  }
}

type ToolHandlers = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in string]: (input: any, ctx: ToolContext) => Promise<Record<string, unknown>>;
};

export const TOOL_HANDLERS: ToolHandlers = {
  get_user_preferences: async (_input, ctx) => {
    const { getProfile } = await import("@agents/db");
    const profile = await getProfile(ctx.db, ctx.userId);
    return {
      name: profile.name,
      timezone: profile.timezone,
      language: profile.language,
      agent_name: profile.agent_name,
    };
  },

  list_enabled_tools: async (_input, ctx) => {
    const enabled = ctx.enabledTools.filter((t) => t.enabled).map((t) => t.tool_id);
    return { enabled };
  },

  github_list_repos: async (input, ctx) =>
    executeGitHubTool("github_list_repos", input, ctx.githubToken!),

  github_list_issues: async (input, ctx) =>
    executeGitHubTool("github_list_issues", input, ctx.githubToken!),

  github_create_issue: async (input, ctx) =>
    executeGitHubTool("github_create_issue", input, ctx.githubToken!),

  github_create_repo: async (input, ctx) =>
    executeGitHubTool("github_create_repo", input, ctx.githubToken!),

  read_file: async (input: { path: string; offset?: number; limit?: number }) => {
    const result = await executeReadFile(input);
    return result as unknown as Record<string, unknown>;
  },

  fetch_url: async (input: { url: string }) => {
    const result = await executeFetchUrl(input);
    return result as unknown as Record<string, unknown>;
  },

  write_file: async (input: { path: string; content: string }) => {
    const result = await executeWriteFile(input);
    return result as unknown as Record<string, unknown>;
  },

  edit_file: async (input: {
    path: string;
    new_string: string;
    old_string?: string;
    insert_position?: "start" | "end" | "before_line" | "after_line";
    line?: number;
  }) => {
    const result = await executeEditFile(input);
    return result as unknown as Record<string, unknown>;
  },

  bash: async (input: { terminal: string; prompt: string }) => {
    const result = await executeBash(input.terminal, input.prompt);
    return result as unknown as Record<string, unknown>;
  },

  schedule_task: async (
    input: {
      prompt: string;
      schedule_type: "one_time" | "recurring";
      run_at?: string;
      cron_expr?: string;
      timezone?: string;
    },
    ctx: ToolContext
  ) => {
    const { Cron } = await import("croner");
    const { createScheduledTask } = await import("@agents/db");
    const { getProfile } = await import("@agents/db");

    const profile = await getProfile(ctx.db, ctx.userId);
    const tz = input.timezone ?? profile.timezone ?? "UTC";

    let nextRunAt: string;

    if (input.schedule_type === "one_time") {
      if (!input.run_at) throw new Error("run_at is required for one_time tasks");
      nextRunAt = new Date(input.run_at).toISOString();
    } else {
      if (!input.cron_expr) throw new Error("cron_expr is required for recurring tasks");
      const job = new Cron(input.cron_expr, { timezone: tz });
      const next = job.nextRun();
      if (!next) throw new Error("Could not compute next run from cron expression");
      nextRunAt = next.toISOString();
    }

    const task = await createScheduledTask(ctx.db, {
      userId: ctx.userId,
      prompt: input.prompt,
      scheduleType: input.schedule_type,
      runAt: input.run_at,
      cronExpr: input.cron_expr,
      timezone: tz,
      nextRunAt,
    });

    const readableTime = new Date(nextRunAt).toLocaleString("es", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "short",
    });

    return {
      ok: true,
      task_id: task.id,
      schedule_type: task.schedule_type,
      next_run_at: nextRunAt,
      message:
        input.schedule_type === "one_time"
          ? `Tarea programada para el ${readableTime} (${tz}). Recibirás el resultado por Telegram.`
          : `Tarea recurrente creada con expresión "${input.cron_expr}". Próxima ejecución: ${readableTime} (${tz}).`,
    };
  },

  list_scheduled_tasks: async (
    input: { status?: ScheduledTaskStatus },
    ctx: ToolContext
  ) => {
    const { listScheduledTasksByUser } = await import("@agents/db");
    const tasks = await listScheduledTasksByUser(ctx.db, ctx.userId, input.status);
    return {
      ok: true,
      tasks: tasks.map((t) => ({
        task_id: t.id,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        cron_expr: t.cron_expr ?? null,
        run_at: t.run_at ?? null,
        next_run_at: t.next_run_at ?? null,
        status: t.status,
        created_at: t.created_at,
      })),
      count: tasks.length,
    };
  },

  cancel_scheduled_task: async (
    input: { task_id?: string; prompt_match?: string; action: "pause" | "delete" },
    ctx: ToolContext
  ) => {
    const {
      getScheduledTaskForUser,
      listScheduledTasksByUser,
      pauseScheduledTask,
      deleteScheduledTask,
    } = await import("@agents/db");

    const resolved = await resolveScheduledTaskTarget(
      ctx.db,
      ctx.userId,
      input,
      ["active", "paused"],
      getScheduledTaskForUser,
      listScheduledTasksByUser
    );
    if (!resolved.ok) {
      return resolved;
    }

    const task = resolved.task;

    if (task.status === "completed") {
      return {
        ok: false,
        error: {
          code: "ALREADY_COMPLETED",
          message: `Task ${task.id} is already completed and cannot be cancelled.`,
        },
      };
    }

    if (input.action === "pause") {
      const updated = await pauseScheduledTask(ctx.db, task.id, ctx.userId);
      if (!updated) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Task not found: ${task.id}` },
        };
      }
      return {
        ok: true,
        task_id: task.id,
        action: "pause",
        message:
          "Tarea pausada. Ya no se ejecutará hasta que uses resume_scheduled_task para reactivarla.",
      };
    }

    const deleted = await deleteScheduledTask(ctx.db, task.id, ctx.userId);
    if (!deleted) {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Task not found: ${task.id}` },
      };
    }
    return {
      ok: true,
      task_id: task.id,
      action: "delete",
      message: "Tarea eliminada permanentemente.",
    };
  },

  resume_scheduled_task: async (
    input: { task_id?: string; prompt_match?: string },
    ctx: ToolContext
  ) => {
    const {
      getScheduledTaskForUser,
      listScheduledTasksByUser,
      resumeScheduledTask,
    } = await import("@agents/db");

    const resolved = await resolveScheduledTaskTarget(
      ctx.db,
      ctx.userId,
      input,
      ["paused"],
      getScheduledTaskForUser,
      listScheduledTasksByUser
    );
    if (!resolved.ok) {
      return resolved;
    }

    const task = resolved.task;

    if (task.status === "active") {
      return {
        ok: false,
        error: {
          code: "ALREADY_ACTIVE",
          message: `Task ${task.id} is already active.`,
        },
      };
    }

    if (task.status === "completed" || task.status === "failed") {
      return {
        ok: false,
        error: {
          code: "CANNOT_RESUME",
          message: `Task ${task.id} has status "${task.status}" and cannot be resumed.`,
        },
      };
    }

    const nextRun = computeNextRunAtForResume(task);
    if (!nextRun.ok) {
      return { ok: false, error: { code: nextRun.code, message: nextRun.message } };
    }

    const updated = await resumeScheduledTask(
      ctx.db,
      task.id,
      ctx.userId,
      nextRun.nextRunAt
    );
    if (!updated) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Task ${task.id} was not paused or no longer exists.`,
        },
      };
    }

    const readableTime = new Date(nextRun.nextRunAt).toLocaleString("es", {
      timeZone: task.timezone,
      dateStyle: "full",
      timeStyle: "short",
    });

    return {
      ok: true,
      task_id: task.id,
      status: "active",
      next_run_at: nextRun.nextRunAt,
      message: `Tarea reactivada. Próxima ejecución: ${readableTime} (${task.timezone}).`,
    };
  },
};

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  for (const def of TOOL_CATALOG) {
    if (!isToolAvailable(def.id, ctx)) continue;

    const schema = TOOL_SCHEMAS[def.id as keyof typeof TOOL_SCHEMAS];
    const handler = TOOL_HANDLERS[def.id];
    if (!schema || !handler) continue;

    const trackedHandler = withTracking(def.id, handler, ctx);

    tools.push(
      tool(trackedHandler, {
        name: def.name,
        description: def.description,
        schema: schema as z.ZodTypeAny,
      })
    );
  }

  return tools;
}
