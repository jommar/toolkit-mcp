import { z } from 'zod';
import { FigmaClient } from '../../services/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from '../helpers.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const fileKeyDescription = 'Figma file key from URL (e.g., "ABC123def456").';

export const figmaGetMeSchema = z.object({});

export const figmaGetFileSchema = z.object({
  fileKey: z.string().min(1).max(50).describe(fileKeyDescription),
  depth: z.number().min(1).max(100).optional().describe('Depth of the document tree to return (e.g., 1 for top-level children only).'),
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
        depth: args.depth,
        ids: args.ids,
        geometry: args.geometry,
        version: args.version,
      });
      // Slim node-tree: when depth is not set, drop document to avoid blowing context
      if (!args.depth && result.document && typeof result.document === 'object' && !('_truncated' in result.document)) {
        (result as unknown as Record<string, unknown>).document = {
          truncated: true,
          message: 'Use depth or ids to narrow the response',
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  };

export const figmaGetNodesHandler: ToolHandler<z.infer<typeof figmaGetNodesSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getNodes(args.fileKey, args.ids);
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
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  };

export const figmaGetStylesHandler: ToolHandler<z.infer<typeof figmaGetStylesSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.getStyles(args.fileKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  };

export const figmaPostCommentHandler: ToolHandler<z.infer<typeof figmaPostCommentSchema>> =
  (clients) => async (args) => {
    return wrapError(async () => {
      const result = await clients.figma.postComment(args.fileKey, args.message, args.parentId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
