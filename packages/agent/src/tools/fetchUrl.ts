const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 512 * 1024; // 512 KB
const USER_AGENT = "10x-builders-agent/1.0";

export interface FetchUrlInput {
  url: string;
}

export interface FetchUrlSuccess {
  ok: true;
  tool: "fetch_url";
  url: string;
  final_url?: string;
  status: number;
  content_type: string;
  format: "json" | "text";
  content: unknown;
}

export interface FetchUrlFailure {
  ok: false;
  tool: "fetch_url";
  url: string;
  error: { code: string; message: string };
}

export type FetchUrlResult = FetchUrlSuccess | FetchUrlFailure;

function failure(url: string, code: string, message: string): FetchUrlFailure {
  return { ok: false, tool: "fetch_url", url, error: { code, message } };
}

function validateUrl(raw: string): URL | FetchUrlFailure {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return failure(raw, "INVALID_URL", `Invalid URL: ${raw}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return failure(raw, "INVALID_URL", "Only http:// and https:// URLs are supported.");
  }

  return parsed;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isJsonContentType(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "application/json" || base.endsWith("+json");
}

function isHtmlContentType(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "text/html" || base === "application/xhtml+xml";
}

async function readBodyWithLimit(res: Response): Promise<string | FetchUrlFailure> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      return failure(res.url, "TOO_LARGE", `Response body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return failure(res.url, "TOO_LARGE", `Response body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(value);
  }

  const combined = Buffer.concat(chunks);
  return combined.toString("utf8");
}

function normalizeContent(
  rawBody: string,
  contentType: string
): { format: "json" | "text"; content: unknown } {
  if (isJsonContentType(contentType)) {
    const parsed = tryParseJson(rawBody);
    if (parsed !== null) {
      return { format: "json", content: parsed };
    }
  }

  const parsed = tryParseJson(rawBody);
  if (parsed !== null) {
    return { format: "json", content: parsed };
  }

  if (isHtmlContentType(contentType)) {
    return { format: "text", content: stripHtml(rawBody) };
  }

  return { format: "text", content: rawBody };
}

export async function executeFetchUrl(input: FetchUrlInput): Promise<FetchUrlResult> {
  if (process.env.FETCH_URL_ENABLED !== "true") {
    return failure(
      input.url,
      "TOOL_DISABLED",
      "Fetch URL tool is disabled. Set FETCH_URL_ENABLED=true to enable it."
    );
  }

  const validated = validateUrl(input.url);
  if ("error" in validated) {
    return validated;
  }
  const url = validated;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/json,text/plain,*/*",
        "User-Agent": USER_AGENT,
      },
    });

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";

    if (!res.ok) {
      return failure(
        input.url,
        "HTTP_ERROR",
        `HTTP ${res.status} ${res.statusText} for ${input.url}`
      );
    }

    const bodyResult = await readBodyWithLimit(res);
    if (typeof bodyResult !== "string") {
      return bodyResult;
    }

    const { format, content } = normalizeContent(bodyResult, contentType);
    const finalUrl = res.url !== url.toString() ? res.url : undefined;

    return {
      ok: true,
      tool: "fetch_url",
      url: input.url,
      ...(finalUrl ? { final_url: finalUrl } : {}),
      status: res.status,
      content_type: contentType,
      format,
      content,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return failure(input.url, "TIMEOUT", `Request timed out after ${TIMEOUT_MS / 1000}s.`);
    }
    return failure(input.url, "FETCH_FAILED", String(err));
  } finally {
    clearTimeout(timeout);
  }
}
