import axios, { AxiosInstance, AxiosRequestConfig, isAxiosError } from 'axios';

const MAX_RETRIES = 3;
/** Liveness-probe timeout — short so an unreachable Jenkins fails fast at bootstrap. */
const PING_TIMEOUT_MS = 3_000;
/** Job names: segments of alphanumerics, space, dot, underscore, hyphen; `/` separates folders. */
const JOB_NAME_PATTERN = /^[A-Za-z0-9 ._-]+(?:\/[A-Za-z0-9 ._-]+)*$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Jenkins ball colors → friendly status. `_anime` suffix means a build is in progress. */
const COLOR_STATUS: Record<string, string> = {
  blue: 'success',
  green: 'success',
  red: 'failed',
  yellow: 'unstable',
  grey: 'pending',
  notbuilt: 'not_built',
  disabled: 'disabled',
  aborted: 'aborted',
};

function colorToStatus(color?: string | null): string {
  if (!color) return 'unknown';
  if (color.endsWith('_anime')) return 'building';
  return COLOR_STATUS[color] ?? color;
}

export interface JenkinsJob {
  name: string;
  url: string;
  /** Friendly status derived from the Jenkins ball color (success/failed/building/…). */
  status: string;
  color: string | null;
  lastBuildNumber: number | null;
  lastResult: string | null;
}

export interface JenkinsBuild {
  number: number;
  /** SUCCESS | FAILURE | UNSTABLE | ABORTED | null (still building). */
  result: string | null;
  building: boolean;
  /** Build start time, epoch milliseconds. */
  timestamp: number;
  durationMs: number;
  url: string;
  displayName: string | null;
}

export interface JenkinsBuildDetail extends JenkinsBuild {
  fullDisplayName: string | null;
  description: string | null;
}

export interface JenkinsConsolePage {
  /** Log lines for the requested window. */
  lines: string[];
  /** Total number of lines in the console log. */
  totalLines: number;
  /** Zero-based index of the first returned line. */
  fromLine: number;
  hasMore: boolean;
  /** Line offset to pass back as `cursor` for the next page (absent when hasMore is false). */
  nextOffset?: number;
}

/**
 * Minimal read-only client over the Jenkins REST API.
 * Auth is HTTP Basic with <user>:<api-token> (JENKINS_USER / JENKINS_TOKEN).
 * A Jenkins API token is strongly preferred over an account password.
 */
export class JenkinsClient {
  private readonly http: AxiosInstance;

  constructor() {
    const baseURL = process.env.JENKINS_URL?.trim().replace(/\/+$/, '');
    const username = process.env.JENKINS_USER?.trim();
    const token = process.env.JENKINS_TOKEN?.trim();
    if (!baseURL || !username || !token) {
      throw new Error(
        'JENKINS_URL, JENKINS_USER, and JENKINS_TOKEN env vars are required. ' +
          'Create an API token at <JENKINS_URL>/user/<you>/configure and add it to .env.',
      );
    }

    this.http = axios.create({
      baseURL,
      auth: { username, password: token },
      timeout: 30_000,
    });
    this.installRetry();
  }

  /** Retry transient failures (429 / 5xx / timeouts) with backoff — mirrors the other clients. */
  private installRetry(): void {
    this.http.interceptors.response.use(undefined, async (error) => {
      const config: any = error.config;
      const status: number | undefined = error.response?.status;
      const retryable =
        status === 429 || (status !== undefined && status >= 500 && status < 600) || error.code === 'ECONNABORTED';
      if (!config || !retryable || config.__noRetry) throw error;

      config.__retryCount = (config.__retryCount ?? 0) + 1;
      if (config.__retryCount > MAX_RETRIES) throw error;

      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(500 * 2 ** (config.__retryCount - 1), 8000);
      await sleep(delayMs);
      return this.http(config);
    });
  }

  /** Turn a "folder/job" name into a Jenkins `/job/<a>/job/<b>` path with encoded segments. */
  private jobPath(job: string): string {
    if (!JOB_NAME_PATTERN.test(job)) {
      throw new Error(`Invalid job name: "${job}".`);
    }
    return job
      .split('/')
      .map((seg) => `/job/${encodeURIComponent(seg)}`)
      .join('');
  }

  /**
   * Resolve a build reference into a path segment. Re-validates buildNumber here (not just at
   * the MCP boundary) so direct library callers can't inject a traversal via the path.
   */
  private buildRef(buildNumber?: number): string {
    if (buildNumber == null) return 'lastBuild';
    if (!Number.isInteger(buildNumber) || buildNumber <= 0) {
      throw new Error(`Invalid build number: ${buildNumber}.`);
    }
    return String(buildNumber);
  }

  /**
   * Fast liveness probe used to gate tool registration at bootstrap: short timeout, no retries,
   * never throws. Returns true whenever Jenkins responds at all — a 401/403 means the server is
   * up but the credentials are off, which the per-call error messages already surface. Only a
   * genuine network failure (no response) reports unreachable.
   */
  async ping(timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
    try {
      await this.http.get('/api/json', {
        params: { tree: 'nodeName' },
        timeout: timeoutMs,
        __noRetry: true,
      } as AxiosRequestConfig & { __noRetry?: boolean });
      return true;
    } catch (err) {
      return isAxiosError(err) && !!err.response;
    }
  }

  /**
   * List jobs with their current status. The Jenkins jobs list is returned in full by the API,
   * so pagination is applied in-memory via offset/limit.
   */
  async getJobs(opts?: { offset?: number; limit?: number }): Promise<{
    items: JenkinsJob[];
    total: number;
    hasMore: boolean;
    nextOffset?: number;
  }> {
    const { data } = await this.http.get<{ jobs?: any[] }>('/api/json', {
      params: { tree: 'jobs[name,url,color,lastBuild[number,result]]' },
    });
    const all = data.jobs ?? [];
    const total = all.length;
    const offset = clamp(opts?.offset ?? 0, 0, total);
    const limit = clamp(opts?.limit ?? 20, 1, 100);
    const items = all.slice(offset, offset + limit).map(
      (j): JenkinsJob => ({
        name: j.name,
        url: j.url,
        status: colorToStatus(j.color),
        color: j.color ?? null,
        lastBuildNumber: j.lastBuild?.number ?? null,
        lastResult: j.lastBuild?.result ?? null,
      }),
    );
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < total;
    return { items, total, hasMore, nextOffset: hasMore ? nextOffset : undefined };
  }

  /** Recent build history for a job, newest first, paginated via offset/limit. */
  async getBuilds(
    job: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<{ items: JenkinsBuild[]; hasMore: boolean; nextOffset?: number }> {
    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = clamp(opts?.limit ?? 20, 1, 100);
    // Fetch one extra to detect further pages. Jenkins range end is exclusive.
    const end = offset + limit + 1;
    const tree = `builds[number,result,building,timestamp,duration,url,displayName]{${offset},${end}}`;
    const { data } = await this.http.get<{ builds?: any[] }>(`${this.jobPath(job)}/api/json`, {
      params: { tree },
    });
    const raw = data.builds ?? [];
    const hasMore = raw.length > limit;
    const items = raw.slice(0, limit).map(mapBuild);
    const nextOffset = offset + items.length;
    return { items, hasMore, nextOffset: hasMore ? nextOffset : undefined };
  }

  /** Single build detail. Defaults to the last build when `buildNumber` is omitted. */
  async getBuild(job: string, buildNumber?: number): Promise<JenkinsBuildDetail> {
    const ref = this.buildRef(buildNumber);
    const tree = 'number,result,building,timestamp,duration,url,displayName,fullDisplayName,description';
    const { data } = await this.http.get<any>(`${this.jobPath(job)}/${ref}/api/json`, {
      params: { tree },
    });
    return {
      ...mapBuild(data),
      fullDisplayName: data.fullDisplayName ?? null,
      description: data.description ?? null,
    };
  }

  /**
   * Console log for a build, paginated by line to keep responses small. Defaults to the last
   * build. The full log is fetched from Jenkins but only the requested line window is returned.
   */
  async getConsole(
    job: string,
    buildNumber?: number,
    opts?: { offset?: number; limit?: number },
  ): Promise<JenkinsConsolePage> {
    const ref = this.buildRef(buildNumber);
    const { data } = await this.http.get<string>(`${this.jobPath(job)}/${ref}/consoleText`, {
      responseType: 'text',
      transformResponse: (d) => d,
    });
    const all = String(data ?? '').split(/\r?\n/);
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    const totalLines = all.length;
    const offset = clamp(opts?.offset ?? 0, 0, totalLines);
    const limit = clamp(opts?.limit ?? 200, 1, 2000);
    const lines = all.slice(offset, offset + limit);
    const nextOffset = offset + lines.length;
    const hasMore = nextOffset < totalLines;
    return { lines, totalLines, fromLine: offset, hasMore, nextOffset: hasMore ? nextOffset : undefined };
  }
}

function mapBuild(b: any): JenkinsBuild {
  return {
    number: b.number,
    result: b.result ?? null,
    building: b.building ?? false,
    timestamp: b.timestamp ?? 0,
    durationMs: b.duration ?? 0,
    url: b.url ?? '',
    displayName: b.displayName ?? null,
  };
}

/** Turn a Jenkins axios error into a concise readable message. */
export function describeJenkinsError(err: unknown): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return `Jenkins auth error (${status}): check JENKINS_USER / JENKINS_TOKEN.`;
    }
    if (status === 404) {
      return 'Jenkins resource not found (404): the job or build number may not exist.';
    }
    return `Jenkins API error${status ? ` (${status})` : ''}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
