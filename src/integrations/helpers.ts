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
  let inner = zodType;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) inner = inner.unwrap();
  while (inner instanceof z.ZodEffects) inner = inner.innerType();
  if (inner instanceof z.ZodString) return { type: 'string' };
  if (inner instanceof z.ZodNumber) return { type: 'number' };
  if (inner instanceof z.ZodBoolean) return { type: 'boolean' };
  if (inner instanceof z.ZodArray) {
    const itemSchema = jsonSchemaTypeForZod(inner.element);
    return { type: 'array', items: itemSchema };
  }
  if (inner instanceof z.ZodObject || inner instanceof z.ZodRecord) return { type: 'object' };
  if (inner instanceof z.ZodEnum) {
    return {
      type: 'string',
      enum: inner._def.values,
    };
  }
  return { type: 'string' };
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  let obj: z.ZodTypeAny = schema;
  while (obj instanceof z.ZodEffects) obj = obj.innerType();
  if (obj instanceof z.ZodOptional || obj instanceof z.ZodNullable) obj = obj.unwrap();
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
