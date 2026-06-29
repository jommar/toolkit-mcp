import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../services/index.js", () => ({
  FigmaClient: class MockFigmaClient {},
}));

import { FigmaModule } from "./index.js";

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

describe("FigmaModule", () => {
  let mod: FigmaModule;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mod = new FigmaModule();
  });

  describe("id", () => {
    it('returns "figma"', () => {
      expect(mod.id).toBe("figma");
    });
  });

  describe("needsEnv", () => {
    beforeEach(() => {
      delete process.env.FIGMA_TOKEN;
    });

    it("returns true when FIGMA_TOKEN is set", () => {
      vi.stubEnv("FIGMA_TOKEN", "figd_abc123");
      expect(mod.needsEnv()).toBe(true);
    });

    it("returns false when FIGMA_TOKEN is missing", () => {
      expect(mod.needsEnv()).toBe(false);
    });

    it("returns false when FIGMA_TOKEN is empty string", () => {
      vi.stubEnv("FIGMA_TOKEN", "");
      expect(mod.needsEnv()).toBe(false);
    });
  });

  describe("createToolHandlers", () => {
    let mockFigma: MockFigma;

    beforeEach(() => {
      mockFigma = makeMockFigma();
    });

    it("returns 8 handlers with expected names", () => {
      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      expect(Object.keys(handlers)).toHaveLength(8);
      expect(handlers).toHaveProperty("figma_get_me");
      expect(handlers).toHaveProperty("figma_get_file");
      expect(handlers).toHaveProperty("figma_get_nodes");
      expect(handlers).toHaveProperty("figma_get_images");
      expect(handlers).toHaveProperty("figma_get_comments");
      expect(handlers).toHaveProperty("figma_get_styles");
      expect(handlers).toHaveProperty("figma_get_variables");
      expect(handlers).toHaveProperty("figma_get_versions");
    });

    it("figma_get_me delegates to handler with parsed args", async () => {
      mockFigma.getMe.mockResolvedValue({
        id: "abc",
        email: "a@b.com",
        handle: "alice",
        img_url: "",
      });

      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      const result = await handlers.figma_get_me({});

      expect(mockFigma.getMe).toHaveBeenCalledOnce();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe("abc");
    });

    it("figma_get_file delegates to handler with parsed args", async () => {
      mockFigma.getFile.mockResolvedValue({
        name: "Test",
        lastModified: "",
        version: "1",
        document: {},
        schemaVersion: 0,
      });

      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      const result = await handlers.figma_get_file({ fileKey: "ABC123" });

      expect(mockFigma.getFile).toHaveBeenCalledWith("ABC123");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.name).toBe("Test");
    });

    it("figma_get_nodes delegates to handler with parsed args", async () => {
      mockFigma.getNodes.mockResolvedValue({
        nodes: { "1:2": { document: {}, schemaVersion: 0 } },
      });

      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      const result = await handlers.figma_get_nodes({
        fileKey: "ABC123",
        ids: "1:2",
      });

      expect(mockFigma.getNodes).toHaveBeenCalledWith("ABC123", "1:2");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.nodes["1:2"].schemaVersion).toBe(0);
    });

    it("figma_get_images delegates to handler with parsed args, including format and scale", async () => {
      mockFigma.getImages.mockResolvedValue({
        images: { "1:2": "https://example.com/img.svg" },
      });

      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      const result = await handlers.figma_get_images({
        fileKey: "ABC123",
        ids: "1:2",
        format: "svg",
        scale: 2,
      });

      expect(mockFigma.getImages).toHaveBeenCalledWith(
        "ABC123",
        "1:2",
        "svg",
        2,
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.images["1:2"]).toBe("https://example.com/img.svg");
    });

    it("figma_get_comments delegates to handler with parsed args", async () => {
      mockFigma.getComments.mockResolvedValue([
        {
          id: "1",
          message: "Nice!",
          file_key: "ABC123",
          user: { id: "u1", handle: "alice", img_url: "" },
          created_at: "",
        },
      ]);

      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      const result = await handlers.figma_get_comments({ fileKey: "ABC123" });

      expect(mockFigma.getComments).toHaveBeenCalledWith("ABC123");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].id).toBe("1");
    });

    it("figma_get_styles delegates to handler with parsed args", async () => {
      mockFigma.getStyles.mockResolvedValue([
        { key: "sk1", name: "Primary", style_type: "FILL", description: "" },
      ]);

      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      const result = await handlers.figma_get_styles({ fileKey: "ABC123" });

      expect(mockFigma.getStyles).toHaveBeenCalledWith("ABC123");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].key).toBe("sk1");
    });

    it("figma_get_variables delegates to handler with parsed args", async () => {
      mockFigma.getVariables.mockResolvedValue({
        status: 200,
        meta: { variableCollections: {}, variables: {} },
      });

      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      const result = await handlers.figma_get_variables({ fileKey: "ABC123" });

      expect(mockFigma.getVariables).toHaveBeenCalledWith("ABC123");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe(200);
    });

    it("figma_get_versions delegates to handler with parsed args", async () => {
      mockFigma.getVersions.mockResolvedValue([
        { id: "v1", created_at: "", user: { id: "u1", handle: "alice" } },
      ]);

      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      const result = await handlers.figma_get_versions({ fileKey: "ABC123" });

      expect(mockFigma.getVersions).toHaveBeenCalledWith("ABC123");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed[0].id).toBe("v1");
    });

    it("rejects invalid args through Zod validation", async () => {
      const handlers = mod.createToolHandlers({ figma: mockFigma as any });
      await expect(handlers.figma_get_file({ fileKey: "" })).rejects.toThrow();
    });
  });

  describe("getToolDescriptors", () => {
    it("returns 8 tool descriptors", () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors).toHaveLength(8);
    });

    it("descriptors have name, description, and inputSchema", () => {
      const descriptors = mod.getToolDescriptors();
      const names = descriptors.map((d) => d.name);
      expect(names).toContain("figma_get_me");
      expect(names).toContain("figma_get_file");
      expect(names).toContain("figma_get_nodes");
      expect(names).toContain("figma_get_images");
      expect(names).toContain("figma_get_comments");
      expect(names).toContain("figma_get_styles");
      expect(names).toContain("figma_get_variables");
      expect(names).toContain("figma_get_versions");
      for (const d of descriptors) {
        expect(d.description).toBeTruthy();
        expect(d.inputSchema).toBeDefined();
      }
    });
  });
});
