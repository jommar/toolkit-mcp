import { fileURLToPath } from 'node:url';
import type { SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import type { Logger } from './integrations/register.js';
import { messageOf } from './integrations/helpers.js';

/** The repo's `skills/` folder, one level above both `src/` and `dist/`. */
export const SKILLS_ROOT = fileURLToPath(new URL('../skills', import.meta.url));

/**
 * Loads the skills under `root` for the MCP Skills extension (`skill://<name>/SKILL.md`). A skill problem is
 * logged and that skill skipped; a catalog that cannot be built at all is logged and the server serves no skills.
 */
export async function loadServedSkills(log: Logger, root = SKILLS_ROOT): Promise<SkillsExtension | undefined> {
  try {
    const catalog = await loadSkills(root, {
      onWarning: (warning) => log.error(`Skill ${warning.path}: ${warning.message}`),
    });
    log.info(`Skills served: ${catalog.entries.length}`);
    return catalog;
  } catch (err) {
    log.error(`Failed to load skills: ${messageOf(err)}`);
    return undefined;
  }
}
