import { FigmaClient } from '../../services/index.js';
import { IntegrationModule, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  figmaGetMeHandler,
  figmaGetFileHandler,
  figmaGetNodesHandler,
  figmaGetImagesHandler,
  figmaGetCommentsHandler,
  figmaGetStylesHandler,
  figmaGetVariablesHandler,
  figmaGetVersionsHandler,
  figmaPostCommentHandler,
  figmaToolDescriptors,
} from './module.js';

export class FigmaModule implements IntegrationModule<{ figma: FigmaClient }> {
  readonly id = 'figma';

  needsEnv(): boolean {
    return !!process.env.FIGMA_TOKEN;
  }

  createToolHandlers(clients: { figma: FigmaClient }): Record<string, ToolHandlerFn> {
    return {
      figma_get_me: figmaGetMeHandler(clients),
      figma_get_file: figmaGetFileHandler(clients),
      figma_get_nodes: figmaGetNodesHandler(clients),
      figma_get_images: figmaGetImagesHandler(clients),
      figma_get_comments: figmaGetCommentsHandler(clients),
      figma_get_styles: figmaGetStylesHandler(clients),
      figma_get_variables: figmaGetVariablesHandler(clients),
      figma_get_versions: figmaGetVersionsHandler(clients),
      figma_post_comment: figmaPostCommentHandler(clients),
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return figmaToolDescriptors;
  }
}
