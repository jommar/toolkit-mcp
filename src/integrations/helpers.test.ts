import { describe, it, expect } from 'vitest';
import { paginated } from './helpers.js';
import { modules } from './index.js';
import { inputJsonSchema } from '../__fixtures__/mcp.js';

describe('helpers exports', () => {
  it('paginated reports hasMore from the next page token', () => {
    expect(paginated([1], 'next')).toEqual({ items: [1], nextPageToken: 'next', hasMore: true });
    expect(paginated([1])).toEqual({ items: [1], nextPageToken: undefined, hasMore: false });
  });
});

describe('all module tool descriptors publish an object input schema', () => {
  for (const mod of modules) {
    it(`module ${mod.id} tool descriptors`, () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors.length).toBeGreaterThan(0);

      for (const descriptor of descriptors) {
        const schema = inputJsonSchema(descriptor) as { type?: string; properties?: Record<string, unknown> };
        expect(schema.type, descriptor.name).toBe('object');
        expect(typeof schema.properties, descriptor.name).toBe('object');
      }
    });
  }

  it('github_create_pr_review_comment keeps its properties through .refine()', () => {
    const descriptor = modules
      .find((m) => m.id === 'github')!
      .getToolDescriptors()
      .find((d) => d.name === 'github_create_pr_review_comment')!;
    const props = (inputJsonSchema(descriptor) as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).length).toBeGreaterThan(0);
  });
});
