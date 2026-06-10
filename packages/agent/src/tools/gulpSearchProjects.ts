const GULP_SEARCH_URL = "https://www.gulp.de/gulp2/rest/internal/projects/search";
const TIMEOUT_MS = 30_000;
const MAX_DESC = 500;
const USER_AGENT = "10x-builders-agent/1.0";

export interface GulpSearchInput {
  query?: string;
  offset?: number;
  limit?: number;
  location?: string;
  remote_only?: boolean;
}

export interface GulpProjectSlim {
  id: string;
  title: string;
  location: string;
  description: string;
  url: string;
  start_date: string | null;
  type: string;
  is_remote_possible: boolean;
  skills: string[];
  published_at: string | null;
}

export interface GulpSearchSuccess {
  ok: true;
  tool: "gulp_search_projects";
  total_count: number;
  returned: number;
  offset: number;
  limit: number;
  query?: string;
  projects: GulpProjectSlim[];
  note?: string;
}

export interface GulpSearchFailure {
  ok: false;
  tool: "gulp_search_projects";
  error: { code: string; message: string };
}

export type GulpSearchResult = GulpSearchSuccess | GulpSearchFailure;

interface RawGulpProject {
  id?: string;
  title?: string;
  location?: string;
  description?: string;
  url?: string;
  startDate?: string | null;
  type?: string;
  isRemoteWorkPossible?: boolean;
  skills?: string[];
  originalPublicationDate?: string | null;
}

interface RawGulpResponse {
  totalCount?: number;
  projects?: RawGulpProject[];
}

function failure(code: string, message: string): GulpSearchFailure {
  return { ok: false, tool: "gulp_search_projects", error: { code, message } };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function slimProject(raw: RawGulpProject): GulpProjectSlim {
  return {
    id: raw.id ?? "",
    title: raw.title ?? "",
    location: raw.location ?? "",
    description: truncate(raw.description ?? "", MAX_DESC),
    url: raw.url ?? "",
    start_date: raw.startDate ?? null,
    type: raw.type ?? "",
    is_remote_possible: raw.isRemoteWorkPossible === true,
    skills: (raw.skills ?? []).map((s) => truncate(s, 200)),
    published_at: raw.originalPublicationDate ?? null,
  };
}

function matchesLocation(project: GulpProjectSlim, locationFilter: string): boolean {
  return project.location.toLowerCase().includes(locationFilter.toLowerCase());
}

function matchesRemoteOnly(project: GulpProjectSlim): boolean {
  return project.is_remote_possible || /remote/i.test(project.location);
}

function applyClientFilters(
  projects: GulpProjectSlim[],
  input: GulpSearchInput
): GulpProjectSlim[] {
  let filtered = projects;

  if (input.location) {
    filtered = filtered.filter((p) => matchesLocation(p, input.location!));
  }

  if (input.remote_only) {
    filtered = filtered.filter((p) => matchesRemoteOnly(p));
  }

  return filtered;
}

export async function executeGulpSearchProjects(input: GulpSearchInput): Promise<GulpSearchResult> {
  if (process.env.GULP_SEARCH_ENABLED !== "true") {
    return failure(
      "TOOL_DISABLED",
      "Gulp search tool is disabled. Set GULP_SEARCH_ENABLED=true to enable it."
    );
  }

  const offset = input.offset ?? 0;
  const limit = input.limit ?? 10;

  const apiBody: Record<string, unknown> = { offset, limit };
  if (input.query) {
    apiBody.query = input.query;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(GULP_SEARCH_URL, {
      method: "POST",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(apiBody),
    });

    if (!res.ok) {
      return failure("HTTP_ERROR", `Gulp API returned HTTP ${res.status} ${res.statusText}`);
    }

    let data: RawGulpResponse;
    try {
      data = (await res.json()) as RawGulpResponse;
    } catch {
      return failure("INVALID_RESPONSE", "Gulp API response was not valid JSON.");
    }

    if (typeof data.totalCount !== "number" || !Array.isArray(data.projects)) {
      return failure("INVALID_RESPONSE", "Gulp API response missing totalCount or projects array.");
    }

    const slimmed = data.projects.map(slimProject);
    const filtered = applyClientFilters(slimmed, input);

    const hasClientFilters = !!(input.location || input.remote_only);
    const note =
      hasClientFilters && filtered.length < slimmed.length
        ? "Client-side filters applied; paginate with offset for more API results."
        : undefined;

    return {
      ok: true,
      tool: "gulp_search_projects",
      total_count: data.totalCount,
      returned: filtered.length,
      offset,
      limit,
      ...(input.query ? { query: input.query } : {}),
      projects: filtered,
      ...(note ? { note } : {}),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return failure("TIMEOUT", `Request timed out after ${TIMEOUT_MS / 1000}s.`);
    }
    return failure("FETCH_FAILED", String(err));
  } finally {
    clearTimeout(timeout);
  }
}
