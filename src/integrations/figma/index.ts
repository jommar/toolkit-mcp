import { FigmaClient } from '../../services/index.js';
import { IntegrationModule, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  figmaGetMeHandler,
  figmaGetMeSchema,
  figmaGetFileHandler,
  figmaGetFileSchema,
  figmaGetNodesHandler,
  figmaGetNodesSchema,
  figmaGetImagesHandler,
  figmaGetImagesSchema,
  figmaGetCommentsHandler,
  figmaGetCommentsSchema,
  figmaGetStylesHandler,
  figmaGetStylesSchema,
  figmaGetVariablesHandler,
  figmaGetVariablesSchema,
  figmaGetVersionsHandler,
  figmaGetVersionsSchema,
  figmaToolDescriptors,
} from './module.js';

export class FigmaModule implements IntegrationModule<{ figma: FigmaClient }> {
  readonly id = 'figma';

  needsEnv(): boolean {
    return !!process.env.FIGMA_TOKEN;
  }

  createToolHandlers(clients: { figma: FigmaClient }): Record<string, ToolHandlerFn> {
    return {
      figma_get_me: async (args) => {
        const parsed = figmaGetMeSchema.parse(args);
        return await figmaGetMeHandler(clients)(parsed);
      },
      figma_get_file: async (args) => {
        const parsed = figmaGetFileSchema.parse(args);
        return await figmaGetFileHandler(clients)(parsed);
      },
      figma_get_nodes: async (args) => {
        const parsed = figmaGetNodesSchema.parse(args);
        return await figmaGetNodesHandler(clients)(parsed);
      },
      figma_get_images: async (args) => {
        const parsed = figmaGetImagesSchema.parse(args);
        return await figmaGetImagesHandler(clients)(parsed);
      },
      figma_get_comments: async (args) => {
        const parsed = figmaGetCommentsSchema.parse(args);
        return await figmaGetCommentsHandler(clients)(parsed);
      },
      figma_get_styles: async (args) => {
        const parsed = figmaGetStylesSchema.parse(args);
        return await figmaGetStylesHandler(clients)(parsed);
      },
      figma_get_variables: async (args) => {
        const parsed = figmaGetVariablesSchema.parse(args);
        return await figmaGetVariablesHandler(clients)(parsed);
      },
      figma_get_versions: async (args) => {
        const parsed = figmaGetVersionsSchema.parse(args);
        return await figmaGetVersionsHandler(clients)(parsed);
      },
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return figmaToolDescriptors;
  }
}
