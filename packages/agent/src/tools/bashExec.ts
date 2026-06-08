import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 4 * 1024 * 1024; // 4 MB

export interface BashResult {
  terminal: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executeBash(terminal: string, prompt: string): Promise<BashResult> {
  if (process.env.BASH_TOOL_ENABLED !== "true") {
    return {
      terminal,
      stdout: "",
      stderr: "Bash tool is disabled. Set BASH_TOOL_ENABLED=true to enable it.",
      exitCode: 1,
    };
  }

  const cwd = await resolveCwd();
  const bashExecutable = resolveBashExecutable();

  return new Promise((resolve) => {
    execFile(
      bashExecutable,
      ["-lc", prompt],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        const exitCode =
          error?.code !== undefined && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({ terminal, stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      }
    );
  });
}

function resolveBashExecutable(): string {
  const override = process.env.BASH_TOOL_SHELL?.trim();
  if (override) return override;

  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return "bash";
}

async function resolveCwd(): Promise<string> {
  const envCwd = process.env.BASH_TOOL_CWD;
  if (!envCwd) return process.cwd();

  try {
    const info = await stat(envCwd);
    if (!info.isDirectory()) {
      console.warn(`[bash] BASH_TOOL_CWD "${envCwd}" is not a directory, falling back to process.cwd()`);
      return process.cwd();
    }
    return envCwd;
  } catch {
    console.warn(`[bash] BASH_TOOL_CWD "${envCwd}" does not exist, falling back to process.cwd()`);
    return process.cwd();
  }
}
