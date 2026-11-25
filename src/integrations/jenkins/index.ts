import { JenkinsClient } from '../../services/index.js';
import { IntegrationModule, ToolHandlerFn, ToolDescriptor } from '../index.js';
import {
  jenkinsGetJobsHandler,
  jenkinsGetBuildsHandler,
  jenkinsGetBuildHandler,
  jenkinsGetConsoleHandler,
  jenkinsHealthcheckHandler,
  jenkinsToolDescriptors,
} from './module.js';

export class JenkinsModule implements IntegrationModule<{ jenkins: JenkinsClient }> {
  readonly id = 'jenkins';

  needsEnv(): boolean {
    return !!(process.env.JENKINS_URL && process.env.JENKINS_USER && process.env.JENKINS_TOKEN);
  }

  createToolHandlers(clients: { jenkins: JenkinsClient }): Record<string, ToolHandlerFn> {
    return {
      jenkins_get_jobs: jenkinsGetJobsHandler(clients),
      jenkins_get_builds: jenkinsGetBuildsHandler(clients),
      jenkins_get_build: jenkinsGetBuildHandler(clients),
      jenkins_get_console: jenkinsGetConsoleHandler(clients),
      jenkins_healthcheck: jenkinsHealthcheckHandler(clients),
    };
  }

  getToolDescriptors(): ToolDescriptor[] {
    return jenkinsToolDescriptors;
  }
}
