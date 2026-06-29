import { vi, describe, it, expect, beforeEach } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

vi.mock("../../services/index.js", () => ({
  FigmaClient: class MockFigmaClient {},
}));

import {
  figmaGetMeHandler,
  figmaGetFileHandler,
  figmaGetNodesHandler,
  figmaGetImagesHandler,
  figmaGetCommentsHandler,
  figmaGetStylesHandler,
  figmaGetVariablesHandler,
  figmaGetVersionsHandler,
  figmaGetFileSchema,
  figmaGetImagesSchema,
  figmaGetNodesSchema,
} from "./module.js";

function makeMockFigma() {
  return {
    getMe: vi.fn(),
    getFile: vi.fn(),
    getNodes: vi.fn(),
    getImages: vi.fn(),
    getComments: vi.fn(),
    getStyles: vi.fn(),
    getVariables: vi.fn(),
    getVersions: vi.fn(),
  };
}

type MockFigma = ReturnType<typeof makeMockFigma>;

describe("figmaGetMeHandler", () => {
  let mockFigma: MockFigma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFigma = makeMockFigma();
  });

  it("returns the authenticated user profile", async () => {
    const user = {
      id: "abc123",
      email: "user@example.com",
      handle: "username",
      img_url: "https://example.com/avatar.png",
    };
    mockFigma.getMe.mockResolvedValue(user);

    const handler = figmaGetMeHandler({ figma: mockFigma as any });
    const result = await handler({});

    expect(mockFigma.getMe).toHaveBeenCalledOnce();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(user);
  });

  it("wraps client errors as McpError", async () => {
    mockFigma.getMe.mockRejectedValue(new Error("API error"));

    const handler = figmaGetMeHandler({ figma: mockFigma as any });
    await expect(handler({})).rejects.toThrow(McpError);
    await expect(handler({})).rejects.toThrow("API error");
  });
});

describe("figmaGetFileHandler", () => {
  let mockFigma: MockFigma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFigma = makeMockFigma();
  });

  it("calls getFile with the fileKey and returns the result", async () => {
    const file = {
      name: "Test File",
      lastModified: "2025-01-01T00:00:00Z",
      version: "123",
      document: {},
      schemaVersion: 0,
    };
    mockFigma.getFile.mockResolvedValue(file);

    const handler = figmaGetFileHandler({ figma: mockFigma as any });
    const result = await handler({ fileKey: "ABC123def456" });

    expect(mockFigma.getFile).toHaveBeenCalledWith("ABC123def456");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(file);
  });

  it("rejects empty fileKey via schema validation", async () => {
    expect(() => figmaGetFileSchema.parse({ fileKey: "" })).toThrow();
  });

  it("wraps client errors as McpError", async () => {
    mockFigma.getFile.mockRejectedValue(new Error("Not found"));

    const handler = figmaGetFileHandler({ figma: mockFigma as any });
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow(McpError);
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow("Not found");
  });
});

describe("figmaGetNodesHandler", () => {
  let mockFigma: MockFigma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFigma = makeMockFigma();
  });

  it("calls getNodes with fileKey and ids", async () => {
    const nodes = { nodes: { "1:2": { document: {}, schemaVersion: 0 } } };
    mockFigma.getNodes.mockResolvedValue(nodes);

    const handler = figmaGetNodesHandler({ figma: mockFigma as any });
    const result = await handler({ fileKey: "ABC123", ids: "1:2,3:4" });

    expect(mockFigma.getNodes).toHaveBeenCalledWith("ABC123", "1:2,3:4");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(nodes);
  });

  it("rejects empty ids via schema validation", async () => {
    expect(() =>
      figmaGetNodesSchema.parse({ fileKey: "ABC123", ids: "" }),
    ).toThrow();
  });

  it("wraps client errors as McpError", async () => {
    mockFigma.getNodes.mockRejectedValue(new Error("API error"));

    const handler = figmaGetNodesHandler({ figma: mockFigma as any });
    await expect(handler({ fileKey: "ABC123", ids: "1:2" })).rejects.toThrow(
      McpError,
    );
    await expect(handler({ fileKey: "ABC123", ids: "1:2" })).rejects.toThrow(
      "API error",
    );
  });
});

describe("figmaGetImagesHandler", () => {
  let mockFigma: MockFigma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFigma = makeMockFigma();
  });

  it("calls getImages with fileKey, ids, and defaults", async () => {
    const images = { images: { "1:2": "https://example.com/image.png" } };
    mockFigma.getImages.mockResolvedValue(images);

    const handler = figmaGetImagesHandler({ figma: mockFigma as any });
    const result = await handler({ fileKey: "ABC123", ids: "1:2" });

    // Zod defaults are applied at the module level, not at the raw handler
    expect(mockFigma.getImages).toHaveBeenCalledWith(
      "ABC123",
      "1:2",
      undefined,
      undefined,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(images);
  });

  it("accepts custom format and scale", async () => {
    mockFigma.getImages.mockResolvedValue({ images: {} });

    const handler = figmaGetImagesHandler({ figma: mockFigma as any });
    await handler({ fileKey: "ABC123", ids: "1:2", format: "svg" });

    expect(mockFigma.getImages).toHaveBeenCalledWith(
      "ABC123",
      "1:2",
      "svg",
      undefined,
    );
  });

  it("rejects invalid format via enum validation", async () => {
    expect(() =>
      figmaGetImagesSchema.parse({
        fileKey: "ABC123",
        ids: "1:2",
        format: "gif",
      }),
    ).toThrow();
  });

  it("rejects scale outside 1-4 range", async () => {
    expect(() =>
      figmaGetImagesSchema.parse({ fileKey: "ABC123", ids: "1:2", scale: 5 }),
    ).toThrow();
    expect(() =>
      figmaGetImagesSchema.parse({ fileKey: "ABC123", ids: "1:2", scale: 0 }),
    ).toThrow();
  });

  it("wraps client errors as McpError", async () => {
    mockFigma.getImages.mockRejectedValue(new Error("API error"));

    const handler = figmaGetImagesHandler({ figma: mockFigma as any });
    await expect(handler({ fileKey: "ABC123", ids: "1:2" })).rejects.toThrow(
      McpError,
    );
    await expect(handler({ fileKey: "ABC123", ids: "1:2" })).rejects.toThrow(
      "API error",
    );
  });
});

describe("figmaGetCommentsHandler", () => {
  let mockFigma: MockFigma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFigma = makeMockFigma();
  });

  it("calls getComments with fileKey and returns array", async () => {
    const comments = [
      {
        id: "1",
        message: "Great design!",
        file_key: "ABC123",
        user: { id: "u1", handle: "alice", img_url: "" },
        created_at: "2025-01-01T00:00:00Z",
      },
    ];
    mockFigma.getComments.mockResolvedValue(comments);

    const handler = figmaGetCommentsHandler({ figma: mockFigma as any });
    const result = await handler({ fileKey: "ABC123" });

    expect(mockFigma.getComments).toHaveBeenCalledWith("ABC123");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(comments);
  });

  it("wraps client errors as McpError", async () => {
    mockFigma.getComments.mockRejectedValue(new Error("API error"));

    const handler = figmaGetCommentsHandler({ figma: mockFigma as any });
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow(McpError);
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow("API error");
  });
});

describe("figmaGetStylesHandler", () => {
  let mockFigma: MockFigma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFigma = makeMockFigma();
  });

  it("calls getStyles with fileKey and returns array", async () => {
    const styles = [
      {
        key: "sk1",
        name: "Primary",
        style_type: "FILL" as const,
        description: "Primary color",
      },
    ];
    mockFigma.getStyles.mockResolvedValue(styles);

    const handler = figmaGetStylesHandler({ figma: mockFigma as any });
    const result = await handler({ fileKey: "ABC123" });

    expect(mockFigma.getStyles).toHaveBeenCalledWith("ABC123");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(styles);
  });

  it("wraps client errors as McpError", async () => {
    mockFigma.getStyles.mockRejectedValue(new Error("API error"));

    const handler = figmaGetStylesHandler({ figma: mockFigma as any });
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow(McpError);
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow("API error");
  });
});

describe("figmaGetVariablesHandler", () => {
  let mockFigma: MockFigma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFigma = makeMockFigma();
  });

  it("calls getVariables with fileKey and returns the response", async () => {
    const variablesResponse = {
      status: 200,
      meta: {
        variableCollections: {},
        variables: {},
      },
    };
    mockFigma.getVariables.mockResolvedValue(variablesResponse);

    const handler = figmaGetVariablesHandler({ figma: mockFigma as any });
    const result = await handler({ fileKey: "ABC123" });

    expect(mockFigma.getVariables).toHaveBeenCalledWith("ABC123");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(variablesResponse);
  });

  it("wraps client errors as McpError", async () => {
    mockFigma.getVariables.mockRejectedValue(new Error("API error"));

    const handler = figmaGetVariablesHandler({ figma: mockFigma as any });
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow(McpError);
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow("API error");
  });
});

describe("figmaGetVersionsHandler", () => {
  let mockFigma: MockFigma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFigma = makeMockFigma();
  });

  it("calls getVersions with fileKey and returns array", async () => {
    const versions = [
      {
        id: "v1",
        created_at: "2025-01-01T00:00:00Z",
        user: { id: "u1", handle: "alice" },
      },
    ];
    mockFigma.getVersions.mockResolvedValue(versions);

    const handler = figmaGetVersionsHandler({ figma: mockFigma as any });
    const result = await handler({ fileKey: "ABC123" });

    expect(mockFigma.getVersions).toHaveBeenCalledWith("ABC123");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(versions);
  });

  it("wraps client errors as McpError", async () => {
    mockFigma.getVersions.mockRejectedValue(new Error("API error"));

    const handler = figmaGetVersionsHandler({ figma: mockFigma as any });
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow(McpError);
    await expect(handler({ fileKey: "ABC123" })).rejects.toThrow("API error");
  });
});
