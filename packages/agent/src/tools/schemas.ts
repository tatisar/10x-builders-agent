import { z } from "zod";

export const TOOL_SCHEMAS = {
  get_user_preferences: z.object({}),
  list_enabled_tools: z.object({}),
  github_list_repos: z.object({
    per_page: z.number().max(30).optional().default(10),
  }),
  github_list_issues: z.object({
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional().default("open"),
  }),
  github_create_issue: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional().default(""),
  }),
  github_create_repo: z.object({
    name: z.string(),
    description: z.string().optional().default(""),
    isPrivate: z.boolean().optional().default(false),
  }),
  read_file: z.object({
    path: z.string().describe("Absolute path or path relative to the server process working directory."),
    offset: z.number().int().min(1).optional().describe("1-based line number to start reading from. Defaults to 1."),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to return starting at offset."),
  }),
  fetch_url: z.object({
    url: z.string().url().describe("Public HTTP or HTTPS URL to fetch."),
  }),
  write_file: z.object({
    path: z.string().describe("Absolute path or path relative to the server process working directory. The file must NOT exist yet."),
    content: z.string().max(500_000).describe("Full UTF-8 content to write into the new file."),
  }),
  edit_file: z
    .object({
      path: z
        .string()
        .describe(
          "Absolute path or path relative to the server process working directory. The file must already exist."
        ),
      old_string: z
        .string()
        .optional()
        .describe(
          "Replace mode only. Literal substring to find; must appear exactly once in the file."
        ),
      new_string: z
        .string()
        .max(500_000)
        .describe(
          "Replace mode: text that replaces old_string. Insert mode: text to insert at insert_position."
        ),
      insert_position: z
        .enum(["start", "end", "before_line", "after_line"])
        .optional()
        .describe(
          "Insert mode. Insert new_string at start/end of file, or before/after a 1-based line number (requires line)."
        ),
      line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based line number. Required when insert_position is before_line or after_line."),
    })
    .superRefine((data, ctx) => {
      if (data.insert_position) {
        if (
          (data.insert_position === "before_line" || data.insert_position === "after_line") &&
          data.line === undefined
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "line is required when insert_position is before_line or after_line",
            path: ["line"],
          });
        }
        return;
      }
      if (data.old_string === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "old_string is required for replace mode. Set insert_position to insert text instead.",
          path: ["old_string"],
        });
      }
    }),
  bash: z.object({
    terminal: z.string().describe("Terminal identifier for correlation and logging"),
    prompt: z.string().max(4096).describe("Bash command to execute"),
  }),
  schedule_task: z
    .object({
      prompt: z.string().min(1).describe("The instruction the agent will run when the task fires."),
      schedule_type: z
        .enum(["one_time", "recurring"])
        .describe("Whether this is a single execution or a recurring one."),
      run_at: z
        .string()
        .optional()
        .describe("ISO 8601 datetime for one_time tasks (e.g. '2026-04-10T09:00:00Z')."),
      cron_expr: z
        .string()
        .optional()
        .describe(
          "5-field cron expression for recurring tasks (e.g. '0 9 * * 1' = every Monday 9 AM)."
        ),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone name (e.g. 'America/Bogota'). Defaults to user timezone."),
    })
    .refine(
      (data) => {
        if (data.schedule_type === "one_time") return !!data.run_at;
        if (data.schedule_type === "recurring") return !!data.cron_expr;
        return false;
      },
      {
        message:
          "one_time tasks require run_at; recurring tasks require cron_expr.",
      }
    ),
  list_scheduled_tasks: z.object({
    status: z
      .enum(["active", "paused", "completed", "failed"])
      .optional()
      .describe("Optional filter by task status. Omit to list all tasks."),
  }),
  cancel_scheduled_task: z
    .object({
      task_id: z.string().uuid().optional().describe("UUID of the task to cancel (preferred)."),
      prompt_match: z
        .string()
        .min(1)
        .optional()
        .describe("Substring to find the task by prompt when task_id is unknown."),
      action: z
        .enum(["pause", "delete"])
        .describe("pause: stop future runs; delete: remove the task permanently."),
    })
    .superRefine((data, ctx) => {
      if (!data.task_id && !data.prompt_match) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Either task_id or prompt_match is required.",
          path: ["task_id"],
        });
      }
    }),
  resume_scheduled_task: z
    .object({
      task_id: z.string().uuid().optional().describe("UUID of the paused task to resume (preferred)."),
      prompt_match: z
        .string()
        .min(1)
        .optional()
        .describe("Substring to find a paused task by prompt when task_id is unknown."),
    })
    .superRefine((data, ctx) => {
      if (!data.task_id && !data.prompt_match) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Either task_id or prompt_match is required.",
          path: ["task_id"],
        });
      }
    }),
} as const;

export type ToolSchemas = typeof TOOL_SCHEMAS;
export type ToolId = keyof ToolSchemas;
