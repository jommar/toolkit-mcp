import { z } from 'zod';
import { JenkinsClient, describeJenkinsError } from '../../services/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { paginated, zodToJsonSchema } from '../helpers.js';

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------
const jobField = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9 ._-]+(?:\/[A-Za-z0-9 ._-]+)*$/, 'Invalid job name')
  .describe('Job name (e.g. "EZAT-backend-dev"). Use "folder/job" for jobs inside a folder.');

const cursorField = z
  .string()
  .max(20)
  .optional()
  .describe('Opaque pagination token from a previous response.');

/** Parse the opaque cursor back into a numeric line/item offset. */
function offsetFromCursor(cursor?: string): number {
  if (!cursor) return 0;
  const n = parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------
export const jenkinsGetJobsSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: cursorField,
});

export const jenkinsGetBuildsSchema = z.object({
  job: jobField,
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: cursorField,
});

export const jenkinsGetBuildSchema = z.object({
  job: jobField,
  buildNumber: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Build number. Omit for the most recent build.'),
});

export const jenkinsGetConsoleSchema = z.object({
  job: jobField,
  buildNumber: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Build number. Omit for the most recent build.'),
  limit: z.number().min(1).max(2000).optional().default(200).describe('Maximum log lines per page (default 200).'),
  cursor: cursorField,
});

export const jenkinsHealthcheckSchema = z.object({
  jobs: z
    .array(jobField)
    .max(50)
    .optional()
    .describe('Specific job names to check (e.g. the three "*-dev" jobs). Omit to check all visible jobs.'),
});

// ---------------------------------------------------------------------------
// Handler Factories
// ---------------------------------------------------------------------------
type ToolHandler<T = unknown> = (
  clients: { jenkins: JenkinsClient },
) => (args: T) => Promise<{ content: { type: 'text'; text: string }[] }>;

function toMcp(err: unknown): never {
  if (err instanceof McpError) throw err;
  throw new McpError(ErrorCode.InternalError, describeJenkinsError(err));
}

export const jenkinsGetJobsHandler: ToolHandler<z.infer<typeof jenkinsGetJobsSchema>> =
  (clients) => async (args) => {
    try {
      const offset = offsetFromCursor(args.cursor);
      const { items, total, hasMore, nextOffset } = await clients.jenkins.getJobs({ offset, limit: args.limit });
      const body = { ...paginated(items, hasMore ? String(nextOffset) : undefined), total };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      toMcp(err);
    }
  };

export const jenkinsGetBuildsHandler: ToolHandler<z.infer<typeof jenkinsGetBuildsSchema>> =
  (clients) => async (args) => {
    try {
      const offset = offsetFromCursor(args.cursor);
      const { items, hasMore, nextOffset } = await clients.jenkins.getBuilds(args.job, { offset, limit: args.limit });
      const body = paginated(items, hasMore ? String(nextOffset) : undefined);
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      toMcp(err);
    }
  };

export const jenkinsGetBuildHandler: ToolHandler<z.infer<typeof jenkinsGetBuildSchema>> =
  (clients) => async (args) => {
    try {
      const build = await clients.jenkins.getBuild(args.job, args.buildNumber);
      return { content: [{ type: 'text', text: JSON.stringify(build) }] };
    } catch (err) {
      toMcp(err);
    }
  };

export const jenkinsGetConsoleHandler: ToolHandler<z.infer<typeof jenkinsGetConsoleSchema>> =
  (clients) => async (args) => {
    try {
      const offset = offsetFromCursor(args.cursor);
      const page = await clients.jenkins.getConsole(args.job, args.buildNumber, { offset, limit: args.limit });
      const body = {
        ...paginated(page.lines, page.hasMore ? String(page.nextOffset) : undefined),
        totalLines: page.totalLines,
        fromLine: page.fromLine,
      };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      toMcp(err);
    }
  };

/** Fetch every visible job, following pagination so a healthcheck never silently caps its scope. */
async function fetchAllJobs(jenkins: JenkinsClient) {
  const all: Awaited<ReturnType<JenkinsClient['getJobs']>>['items'] = [];
  let offset = 0;
  for (;;) {
    const { items, hasMore, nextOffset } = await jenkins.getJobs({ offset, limit: 100 });
    all.push(...items);
    if (!hasMore || nextOffset == null) break;
    offset = nextOffset;
  }
  return all;
}

export const jenkinsHealthcheckHandler: ToolHandler<z.infer<typeof jenkinsHealthcheckSchema>> =
  (clients) => async (args) => {
    try {
      const all = await fetchAllJobs(clients.jenkins);
      const byName = new Map(all.map((j) => [j.name, j]));
      const targets = [...new Set(args.jobs?.length ? args.jobs : all.map((j) => j.name))];

      const jobs: {
        job: string;
        lastBuildNumber: number | null;
        lastResult: string | null;
        buildUrl: string | null;
        healthy: boolean;
      }[] = [];
      const unhealthy: { job: string; lastResult: string | null; buildUrl: string | null }[] = [];
      const building: { job: string; buildUrl: string | null }[] = [];
      const notFound: string[] = [];

      for (const name of targets) {
        const j = byName.get(name);
        if (!j) {
          notFound.push(name);
          continue;
        }
        const buildUrl = j.lastBuildNumber != null ? `${j.url}${j.lastBuildNumber}/` : null;
        const healthy = j.lastResult === 'SUCCESS';
        const inProgress = j.lastResult == null && j.lastBuildNumber != null;
        jobs.push({ job: j.name, lastBuildNumber: j.lastBuildNumber, lastResult: j.lastResult, buildUrl, healthy });
        if (inProgress) building.push({ job: j.name, buildUrl });
        else if (!healthy) unhealthy.push({ job: j.name, lastResult: j.lastResult, buildUrl });
      }

      const body = {
        healthy: unhealthy.length === 0 && notFound.length === 0,
        checked: jobs.length,
        jobs,
        unhealthy,
        building,
        notFound,
      };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      toMcp(err);
    }
  };

/** All tool descriptors for the ListToolsRequestSchema response. */
export const jenkinsToolDescriptors = [
  {
    name: 'jenkins_get_jobs',
    description: 'List Jenkins jobs with their current build status.',
    inputSchema: zodToJsonSchema(jenkinsGetJobsSchema),
  },
  {
    name: 'jenkins_get_builds',
    description: 'List recent builds for a job (newest first), paginated.',
    inputSchema: zodToJsonSchema(jenkinsGetBuildsSchema),
  },
  {
    name: 'jenkins_get_build',
    description: 'Get details for a single build; omit buildNumber for the most recent build.',
    inputSchema: zodToJsonSchema(jenkinsGetBuildSchema),
  },
  {
    name: 'jenkins_get_console',
    description: 'Get a build console log, paginated by line; omit buildNumber for the most recent build.',
    inputSchema: zodToJsonSchema(jenkinsGetConsoleSchema),
  },
  {
    name: 'jenkins_healthcheck',
    description: 'Report whether the last build of each requested job succeeded; omit `jobs` to check all visible jobs.',
    inputSchema: zodToJsonSchema(jenkinsHealthcheckSchema),
  },
];
