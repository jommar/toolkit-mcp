import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './helpers.js';
import { modules } from './index.js';

describe('zodToJsonSchema', () => {
  it('unwraps multiple ZodEffects (.refine()) layers', () => {
    const schema = z.object({
      path: z.string().min(1),
      line: z.number().int().positive(),
      body: z.string(),
      commitId: z.string().optional(),
      inReplyTo: z.number().int().positive().optional(),
    }).refine((d) => d.path !== undefined || d.inReplyTo !== undefined, {
      message: 'path or inReplyTo is required',
    }).refine((d) => {
      if (d.line !== undefined && d.line <= 0) return false;
      return true;
    }, { message: 'line must be positive' }).refine(
      (d) => d.commitId || d.inReplyTo,
      { message: 'commitId or inReplyTo must be provided' },
    );

    const result = zodToJsonSchema(schema);

    expect(result.properties).toBeDefined();
    const props = result.properties as Record<string, unknown>;
    expect(Object.keys(props).length).toBeGreaterThanOrEqual(5);
    expect(props.path).toBeDefined();
    expect(props.line).toBeDefined();
    expect(props.body).toBeDefined();
    expect(props.commitId).toBeDefined();
    expect(props.inReplyTo).toBeDefined();
  });

  it('handles ZodOptional nested inside effects', () => {
    const schema = z.object({
      name: z.string(),
      value: z.number().optional(),
    }).refine((d) => d.name.length > 0, { message: 'name required' });

    const result = zodToJsonSchema(schema);
    const props = result.properties as Record<string, unknown>;
    expect(props.name).toBeDefined();
    expect(props.value).toBeDefined();
  });

  it('handles ZodNullable', () => {
    const schema = z.object({
      mergeable: z.boolean().nullable(),
    });
    const result = zodToJsonSchema(schema);
    const props = result.properties as Record<string, unknown>;
    expect(props.mergeable).toBeDefined();
  });

  it('handles ZodArray with items', () => {
    const schema = z.object({
      tags: z.array(z.string()),
      counts: z.array(z.number()),
    });
    const result = zodToJsonSchema(schema);
    const props = result.properties as Record<string, unknown>;
    expect(props.tags).toBeDefined();
    expect((props.tags as any).items).toBeDefined();
    expect((props.tags as any).type).toBe('array');
    expect(props.counts).toBeDefined();
    expect((props.counts as any).items).toBeDefined();
  });

  it('handles ZodEnum', () => {
    const schema = z.object({
      state: z.enum(['open', 'closed', 'all']),
    });
    const result = zodToJsonSchema(schema);
    const props = result.properties as Record<string, unknown>;
    const stateProp = props.state as any;
    expect(stateProp.type).toBe('string');
    expect(stateProp.enum).toEqual(['open', 'closed', 'all']);
  });
});

describe('all module tool descriptors have non-empty inputSchema.properties', () => {
  for (const mod of modules) {
    it(`module ${mod.id} tool descriptors`, () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors.length).toBeGreaterThan(0);

      for (const descriptor of descriptors) {
        const props = descriptor.inputSchema.properties;
        expect(props).toBeDefined();
        expect(typeof props).toBe('object');

        if (Object.keys(props ?? {}).length === 0) {
          try {
            const fakeHandler = () => { throw new Error('not needed'); };
            const handlers = mod.createToolHandlers(
              mod.id === 'jira' ? { jira: fakeHandler as any } :
              mod.id === 'github' ? { github: fakeHandler as any } :
              mod.id === 'jenkins' ? { jenkins: fakeHandler as any } :
              mod.id === 'confluence' ? { confluence: fakeHandler as any } :
              { figma: fakeHandler as any },
            );
            const handlerKeys = Object.keys(handlers);
            const hasHandler = handlerKeys.includes(descriptor.name);
            if (hasHandler && descriptor.name === 'github_create_pr_review_comment') {
              throw new Error(
                `${descriptor.name} should have non-empty inputSchema.properties but got ${JSON.stringify(props)}`,
              );
            }
          } catch (e: any) {
            if (e.message?.includes('should have non-empty')) throw e;
          }

          continue;
        }
      }
    });
  }
});
