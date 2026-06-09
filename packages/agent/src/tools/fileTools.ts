import { access, constants, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const MAX_READ_LINES = 2_000;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB

// ---------------------------------------------------------------------------
// Path resolution — no root confinement, mirrors bash tool behaviour
// ---------------------------------------------------------------------------

/**
 * Resolves `userPath` to an absolute path.
 * - Absolute paths are used as-is.
 * - Relative paths are resolved against `process.cwd()` (same as the bash tool).
 * Returns `{ ok: false }` only when the tool is disabled via env flag.
 */
function safePath(
  userPath: string
): { ok: true; resolved: string } | { ok: false; code: string; message: string } {
  if (process.env.FILE_TOOLS_ENABLED !== "true") {
    return {
      ok: false,
      code: "TOOL_DISABLED",
      message: "File tools are disabled. Set FILE_TOOLS_ENABLED=true to enable them.",
    };
  }

  const resolved = normalize(isAbsolute(userPath) ? userPath : resolve(process.cwd(), userPath));
  return { ok: true, resolved };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadFileSuccess {
  ok: true;
  tool: "read_file";
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

export interface ReadFileFailure {
  ok: false;
  tool: "read_file";
  path: string;
  error: { code: string; message: string };
}

export type ReadFileResult = ReadFileSuccess | ReadFileFailure;

export async function executeReadFile(input: ReadFileInput): Promise<ReadFileResult> {
  const safe = safePath(input.path);
  if (!safe.ok) {
    return { ok: false, tool: "read_file", path: input.path, error: { code: safe.code, message: safe.message } };
  }

  const { resolved } = safe;

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(resolved);
  } catch {
    return { ok: false, tool: "read_file", path: resolved, error: { code: "NOT_FOUND", message: `File not found: ${resolved}` } };
  }

  if (fileStat.isDirectory()) {
    return { ok: false, tool: "read_file", path: resolved, error: { code: "IS_DIRECTORY", message: `Path is a directory, not a file: ${resolved}` } };
  }

  if (fileStat.size > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      tool: "read_file",
      path: resolved,
      error: {
        code: "FILE_TOO_LARGE",
        message: `File is ${fileStat.size} bytes, which exceeds the ${MAX_CONTENT_BYTES / 1024 / 1024} MB limit. Use offset and limit to read a specific line range.`,
      },
    };
  }

  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (err) {
    return { ok: false, tool: "read_file", path: resolved, error: { code: "READ_ERROR", message: String(err) } };
  }

  const allLines = raw.split("\n");
  const totalLines = allLines.length;

  const startLine = input.offset ?? 1;
  const maxLines = input.limit ?? MAX_READ_LINES;

  if (startLine < 1 || startLine > totalLines) {
    return {
      ok: false,
      tool: "read_file",
      path: resolved,
      error: {
        code: "OFFSET_OUT_OF_RANGE",
        message: `offset ${startLine} is out of range. File has ${totalLines} lines (1-based).`,
      },
    };
  }

  // Slice is 0-based internally
  const sliced = allLines.slice(startLine - 1, startLine - 1 + maxLines);
  const endLine = startLine + sliced.length - 1;

  return {
    ok: true,
    tool: "read_file",
    path: resolved,
    content: sliced.join("\n"),
    startLine,
    endLine,
    totalLines,
  };
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface WriteFileSuccess {
  ok: true;
  tool: "write_file";
  path: string;
  bytesWritten: number;
}

export interface WriteFileFailure {
  ok: false;
  tool: "write_file";
  path: string;
  error: { code: string; message: string };
}

export type WriteFileResult = WriteFileSuccess | WriteFileFailure;

export async function executeWriteFile(input: WriteFileInput): Promise<WriteFileResult> {
  const safe = safePath(input.path);
  if (!safe.ok) {
    return { ok: false, tool: "write_file", path: input.path, error: { code: safe.code, message: safe.message } };
  }

  const { resolved } = safe;

  // Check file does NOT already exist
  try {
    await access(resolved, constants.F_OK);
    // If we get here the file exists → fail
    return {
      ok: false,
      tool: "write_file",
      path: resolved,
      error: {
        code: "FILE_EXISTS",
        message: `File already exists: ${resolved}. Use edit_file to modify an existing file.`,
      },
    };
  } catch {
    // access threw → file does not exist, which is what we want
  }

  // Create parent directories
  try {
    await mkdir(dirname(resolved), { recursive: true });
  } catch (err) {
    return { ok: false, tool: "write_file", path: resolved, error: { code: "MKDIR_ERROR", message: `Could not create parent directories: ${String(err)}` } };
  }

  // Write using 'wx' flag to fail if another process races and creates the file
  const bytes = Buffer.from(input.content, "utf8");
  try {
    const fh = await open(resolved, "wx");
    try {
      await fh.write(bytes);
    } finally {
      await fh.close();
    }
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "EEXIST") {
      return {
        ok: false,
        tool: "write_file",
        path: resolved,
        error: { code: "FILE_EXISTS", message: `File already exists: ${resolved}. Use edit_file to modify an existing file.` },
      };
    }
    return { ok: false, tool: "write_file", path: resolved, error: { code: "WRITE_ERROR", message: String(err) } };
  }

  return { ok: true, tool: "write_file", path: resolved, bytesWritten: bytes.length };
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export type InsertPosition = "start" | "end" | "before_line" | "after_line";

export interface EditFileInput {
  path: string;
  new_string: string;
  old_string?: string;
  insert_position?: InsertPosition;
  line?: number;
}

export interface EditFileReplaceSuccess {
  ok: true;
  tool: "edit_file";
  path: string;
  operation: "replace";
  replacements: 1;
}

export interface EditFileInsertSuccess {
  ok: true;
  tool: "edit_file";
  path: string;
  operation: "insert";
  insert_position: InsertPosition;
  line?: number;
}

export type EditFileSuccess = EditFileReplaceSuccess | EditFileInsertSuccess;

export interface EditFileFailure {
  ok: false;
  tool: "edit_file";
  path: string;
  error: { code: string; message: string };
}

export type EditFileResult = EditFileSuccess | EditFileFailure;

export async function executeEditFile(input: EditFileInput): Promise<EditFileResult> {
  const safe = safePath(input.path);
  if (!safe.ok) {
    return { ok: false, tool: "edit_file", path: input.path, error: { code: safe.code, message: safe.message } };
  }

  const { resolved } = safe;

  let original: string;
  try {
    original = await readFile(resolved, "utf8");
  } catch {
    return { ok: false, tool: "edit_file", path: resolved, error: { code: "NOT_FOUND", message: `File not found: ${resolved}` } };
  }

  let updated: string;
  let success: EditFileSuccess;

  if (input.insert_position) {
    const insertResult = applyInsert(original, input.new_string, input.insert_position, input.line);
    if (!insertResult.ok) {
      return {
        ok: false,
        tool: "edit_file",
        path: resolved,
        error: { code: insertResult.code, message: insertResult.message },
      };
    }
    updated = insertResult.content;
    success = {
      ok: true,
      tool: "edit_file",
      path: resolved,
      operation: "insert",
      insert_position: input.insert_position,
      ...(input.line !== undefined ? { line: input.line } : {}),
    };
  } else {
    if (input.old_string === undefined) {
      return {
        ok: false,
        tool: "edit_file",
        path: resolved,
        error: {
          code: "MISSING_OLD_STRING",
          message:
            "old_string is required for replace mode. Omit insert_position to replace text, or set insert_position (start, end, before_line, after_line) to insert new_string.",
        },
      };
    }

    const occurrences = countOccurrences(original, input.old_string);

    if (occurrences === 0) {
      return {
        ok: false,
        tool: "edit_file",
        path: resolved,
        error: {
          code: "OLD_STRING_NOT_FOUND",
          message: `old_string was not found in the file. Make sure the text matches exactly (including whitespace and line endings).`,
        },
      };
    }

    if (occurrences > 1) {
      return {
        ok: false,
        tool: "edit_file",
        path: resolved,
        error: {
          code: "OLD_STRING_AMBIGUOUS",
          message: `old_string appears ${occurrences} times in the file. Provide more surrounding context in old_string so it matches exactly once.`,
        },
      };
    }

    updated = original.replace(input.old_string, input.new_string);
    success = {
      ok: true,
      tool: "edit_file",
      path: resolved,
      operation: "replace",
      replacements: 1,
    };
  }

  const writeError = await writeFileAtomically(resolved, updated);
  if (writeError) {
    return { ok: false, tool: "edit_file", path: resolved, error: writeError };
  }

  return success;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function getLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function applyInsert(
  content: string,
  text: string,
  position: InsertPosition,
  line?: number
): { ok: true; content: string } | { ok: false; code: string; message: string } {
  if (position === "start") {
    return { ok: true, content: text + content };
  }

  if (position === "end") {
    return { ok: true, content: content + text };
  }

  if (line === undefined) {
    return {
      ok: false,
      code: "MISSING_LINE",
      message: `line is required when insert_position is "${position}".`,
    };
  }

  const lineStarts = getLineStarts(content);
  const totalLines = lineStarts.length;

  if (line < 1 || line > totalLines) {
    return {
      ok: false,
      code: "LINE_OUT_OF_RANGE",
      message: `line ${line} is out of range. The file has ${totalLines} line(s).`,
    };
  }

  const index =
    position === "before_line"
      ? lineStarts[line - 1]!
      : line === totalLines
        ? content.length
        : lineStarts[line]!;

  return {
    ok: true,
    content: content.slice(0, index) + text + content.slice(index),
  };
}

async function writeFileAtomically(
  resolved: string,
  content: string
): Promise<{ code: string; message: string } | null> {
  const tmp = resolve(dirname(resolved), `.tmp_${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, resolved);
    return null;
  } catch (err) {
    try {
      await access(tmp);
      await writeFile(tmp, "");
    } catch {
      /* ignore */
    }
    return { code: "WRITE_ERROR", message: String(err) };
  }
}
