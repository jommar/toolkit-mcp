import { z } from 'zod';

// ---------------------------------------------------------------------------
// Paginated Response Shape
// ---------------------------------------------------------------------------
export interface PaginatedResponse<T> {
  items: T[];
  nextPageToken?: string;
  hasMore: boolean;
}

export function paginated<T>(items: T[], nextPageToken?: string): PaginatedResponse<T> {
  return { items, nextPageToken, hasMore: !!nextPageToken };
}

// ---------------------------------------------------------------------------
// Build JSON Schema from a Zod schema (for MCP ListToolsRequestSchema)
// ---------------------------------------------------------------------------

function jsonSchemaTypeForZod(zodType: z.ZodTypeAny): Record<string, unknown> {
  if (zodType instanceof z.ZodString) return { type: 'string' };
  if (zodType instanceof z.ZodNumber) return { type: 'number' };
  if (zodType instanceof z.ZodBoolean) return { type: 'boolean' };
  if (zodType instanceof z.ZodArray) return { type: 'array' };
  if (zodType instanceof z.ZodObject || zodType instanceof z.ZodRecord) return { type: 'object' };
  if (zodType instanceof z.ZodEnum) {
    return {
      type: 'string',
      enum: zodType._def.values,
    };
  }
  // Fallback for nullable, union, intersection, etc.
  return { type: 'string' };
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap ZodEffects (e.g., from .refine()) to get the inner object
  const obj = schema instanceof z.ZodEffects ? schema.innerType() : schema;
  if (!(obj instanceof z.ZodObject)) {
    return { type: 'object', properties: {} };
  }
  const shape = obj.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const key of Object.keys(shape)) {
    const zodType: z.ZodTypeAny = shape[key];
    const isOptional = zodType.isOptional();
    const description = (zodType.description as string | undefined) ?? '';

    // Unwrap optional/default to get the inner type for type inference
    let inner = zodType;
    if (inner instanceof z.ZodDefault) inner = (inner as any)._def.innerType;
    if (inner instanceof z.ZodOptional) inner = inner.unwrap();

    let defaultVal: unknown;
    if (zodType instanceof z.ZodDefault) {
      defaultVal = zodType._def.defaultValue();
    }

    const typeInfo = jsonSchemaTypeForZod(inner);
    const prop: Record<string, unknown> = {
      ...typeInfo,
      description,
    };
    if (defaultVal !== undefined) {
      prop.default = defaultVal;
    }
    properties[key] = prop;

    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
