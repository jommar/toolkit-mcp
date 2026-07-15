import { JenkinsClient } from '../../services/index.js';
import { IntegrationModule, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  jenkinsGetJobsHandler,
  jenkinsGetJobsSchema,
  jenkinsGetBuildsHandler,
  jenkinsGetBuildsSchema,
  jenkinsGetBuildHandler,
  jenkinsGetBuildSchema,
  jenkinsGetConsoleHandler,
  jenkinsGetConsoleSchema,
  jenkinsHealthcheckHandler,
  jenkinsHealthcheckSchema,
  jenkinsToolDescriptors,
} from './module.js';

export class JenkinsModule implements IntegrationModule<{ jenkins: JenkinsClient }> {
  readonly id = 'jenkins';

  needsEnv(): boolean {
    return !!(process.env.JENKINS_URL && process.env.JENKINS_USER && process.env.JENKINS_TOKEN);
  }

  createToolHandlers(clients: { jenkins: JenkinsClient }): Record<string, ToolHandlerFn> {
    return {
      jenkins_get_jobs: async (args) => {
        const parsed = jenkinsGetJobsSchema.parse(args);
        return await jenkinsGetJobsHandler(clients)(parsed);
      },
      jenkins_get_builds: async (args) => {
        const parsed = jenkinsGetBuildsSchema.parse(args);
        return await jenkinsGetBuildsHandler(clients)(parsed);
      },
      jenkins_get_build: async (args) => {
        const parsed = jenkinsGetBuildSchema.parse(args);
        return await jenkinsGetBuildHandler(clients)(parsed);
      },
      jenkins_get_console: async (args) => {
        const parsed = jenkinsGetConsoleSchema.parse(args);
        return await jenkinsGetConsoleHandler(clients)(parsed);
      },
      jenkins_healthcheck: async (args) => {
        const parsed = jenkinsHealthcheckSchema.parse(args);
        return await jenkinsHealthcheckHandler(clients)(parsed);
      },
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return jenkinsToolDescriptors;
  }
}
