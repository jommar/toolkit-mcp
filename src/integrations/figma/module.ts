import { z } from 'zod';
import { FigmaClient, type FigmaComment, type FigmaStyle, type FigmaVersion } from '../../services/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from '../helpers.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const fileKeyDescription = 'Figma file key from URL (e.g., "ABC123def456").';

/** Tree depth applied to figma_get_file and figma_get_nodes when the caller gives none; pass `depth` (max 100) to go deeper. */
const DEFAULT_TREE_DEPTH = 2;
const depthDescription = `Depth of the node tree to return (default ${DEFAULT_TREE_DEPTH}; raise it, up to 100, to read deeper).`;

export const figmaGetMeSchema = z.object({});

export const figmaGetFileSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
  depth: z.number().min(1).max(100).optional().describe(depthDescription),
  ids: z.string().min(1).max(500).optional().describe('Comma-separated node IDs to include (e.g., "1:2,3:4").'),
  geometry: z.string().min(1).max(50).optional().describe('Geometry type to return (e.g., "paths").'),
  version: z.string().min(1).max(50).optional().describe('Version ID to retrieve (from getVersions).'),
});

export const figmaGetNodesSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
  ids: z
    .string()
    .min(1)
    .max(500)
    .describe('Comma-separated node IDs (e.g., "1:2,3:4").'),
  depth: z.number().min(1).max(100).optional().describe(depthDescription),
});

export const figmaGetImagesSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
  ids: z
    .string()
    .min(1)
    .max(500)
    .describe('Comma-separated node IDs to export (e.g., "1:2,3:4").'),
  format: z.enum(['png', 'svg', 'pdf']).optional().default('png').describe('Export format.'),
  scale: z
    .number()
    .min(1)
    .max(4)
    .optional()
    .default(1)
    .describe('Export scale 1-4. Only applies to PNG format.'),
});

export const figmaGetCommentsSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
});

export const figmaGetStylesSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
});

export const figmaGetVariablesSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
});

export const figmaGetVersionsSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
});

export const figmaPostCommentSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
  message: z.string().min(1).max(10000).describe('Comment message text.'),
  parentId: z.string().optional().describe('Parent comment ID for threading replies.'),
});

// ---------------------------------------------------------------------------
// Handler Factories
// ---------------------------------------------------------------------------

type ToolHandler<T = unknown> = (
  clients: { figma: FigmaClient },
) => (args: T) => Promise<{
  content: { type: 'text'; text: string }[];
}>;

function wrapError<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    );
  });
}

/** Drop avatar and position bloat from a Figma user. */
function slimUser(user?: { id?: string; handle?: string }) {
  return user && { id: user.id, handle: user.handle };
}

function slimComment(c: FigmaComment) {
  return {
    id: c.id,
    message: c.message,
    user: slimUser(c.user),
    created_at: c.created_at,
    resolved_at: c.resolved_at,
    parent_id: c.parent_id,
    node_id: c.client_meta?.node_id,
  };
}

function slimStyle(s: FigmaStyle) {
  return { key: s.key, name: s.name, style_type: s.style_type, node_id: s.node_id, description: s.description };
}

function slimVersion(v: FigmaVersion) {
  return { id: v.id, created_at: v.created_at, label: v.label, description: v.description, user: slimUser(v.user) };
}

export const figmaGetMeHandler: ToolHandler<z.infer<typeof figmaGetMeSchema>> =
  (clients) => async (_args) => {
    return wrapError(async () => {
      const result = await clients.figma.getMe();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  };

export const figmaGetFileHandler: ToolHandler<z.infer<typeof figmaGetFileSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getFile(args.fileKey, {
        depth: args.depth ?? DEFAULT_TREE_DEPTH,
        ids: args.ids,
        geometry: args.geometry,
        version: args.version,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  };

export const figmaGetNodesHandler: ToolHandler<z.infer<typeof figmaGetNodesSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getNodes(args.fileKey, args.ids, args.depth ?? DEFAULT_TREE_DEPTH);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  };

export const figmaGetImagesHandler: ToolHandler<z.infer<typeof figmaGetImagesSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getImages(args.fileKey, args.ids, args.format, args.scale);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  };

export const figmaGetCommentsHandler: ToolHandler<z.infer<typeof figmaGetCommentsSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getComments(args.fileKey);
      return { content: [{ type: 'text', text: JSON.stringify(result.map(slimComment)) }] };
    });
  };

export const figmaGetStylesHandler: ToolHandler<z.infer<typeof figmaGetStylesSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getStyles(args.fileKey);
      return { content: [{ type: 'text', text: JSON.stringify(result.map(slimStyle)) }] };
    });
  };

export const figmaGetVariablesHandler: ToolHandler<z.infer<typeof figmaGetVariablesSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getVariables(args.fileKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  };

export const figmaGetVersionsHandler: ToolHandler<z.infer<typeof figmaGetVersionsSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getVersions(args.fileKey);
      return { content: [{ type: 'text', text: JSON.stringify(result.map(slimVersion)) }] };
    });
  };

export const figmaPostCommentHandler: ToolHandler<z.infer<typeof figmaPostCommentSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.postComment(args.fileKey, args.message, args.parentId);
      return { content: [{ type: 'text', text: JSON.stringify(slimComment(result)) }] };
    });
  };

// ---------------------------------------------------------------------------
// Tool Descriptors
// ---------------------------------------------------------------------------

export const figmaToolDescriptors = [
  {
    name: 'figma_get_me',
    description: 'Get the authenticated Figma user profile.',
    inputSchema: zodToJsonSchema(figmaGetMeSchema),
  },
  {
    name: 'figma_get_file',
    description: 'Get a Figma file by its key.',
    inputSchema: zodToJsonSchema(figmaGetFileSchema),
  },
  {
    name: 'figma_get_nodes',
    description: 'Get specific nodes from a Figma file by their IDs.',
    inputSchema: zodToJsonSchema(figmaGetNodesSchema),
  },
  {
    name: 'figma_get_images',
    description: 'Export images for specific nodes in a Figma file.',
    inputSchema: zodToJsonSchema(figmaGetImagesSchema),
  },
  {
    name: 'figma_get_comments',
    description: 'Get comments on a Figma file.',
    inputSchema: zodToJsonSchema(figmaGetCommentsSchema),
  },
  {
    name: 'figma_get_styles',
    description: 'Get styles published to a Figma file.',
    inputSchema: zodToJsonSchema(figmaGetStylesSchema),
  },
  {
    name: 'figma_get_variables',
    description: 'Get local variables in a Figma file.',
    inputSchema: zodToJsonSchema(figmaGetVariablesSchema),
  },
  {
    name: 'figma_get_versions',
    description: 'Get version history of a Figma file.',
    inputSchema: zodToJsonSchema(figmaGetVersionsSchema),
  },
  {
    name: 'figma_post_comment',
    description: 'Post a comment on a Figma file.',
    inputSchema: zodToJsonSchema(figmaPostCommentSchema),
  },
];
