// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

export interface FigmaUser {
  id: string;
  email: string;
  handle: string;
  img_url: string;
}

export interface FigmaFileResponse {
  name: string;
  lastModified: string;
  thumbnailUrl?: string;
  version: string;
  document: Record<string, unknown>;
  components?: Record<string, unknown>;
  componentSets?: Record<string, unknown>;
  schemaVersion: number;
  styles?: Record<string, unknown>;
}

export interface FigmaNodesResponse {
  nodes: Record<
    string,
    {
      document: Record<string, unknown>;
      components?: Record<string, unknown>;
      componentSets?: Record<string, unknown>;
      schemaVersion: number;
      styles?: Record<string, unknown>;
    }
  >;
}

export interface FigmaImagesResponse {
  images: Record<string, string | null>;
  err?: string;
}

export interface FigmaComment {
  id: string;
  message: string;
  file_key: string;
  parent_id?: string;
  user: { id: string; handle: string; img_url: string };
  created_at: string;
  resolved_at?: string;
  order_id?: string;
}

export interface FigmaStyle {
  key: string;
  name: string;
  style_type: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
  description: string;
  [key: string]: unknown;
}

export interface FigmaVariablesResponse {
  status: number;
  error?: boolean;
  meta: {
    variableCollections: Record<
      string,
      {
        id: string;
        name: string;
        modes: Array<{ modeId: string; name: string }>;
        defaultModeId: string;
        remote: boolean;
        key: string;
        variableIds: string[];
      }
    >;
    variables: Record<
      string,
      {
        id: string;
        name: string;
        key: string;
        variableCollectionId: string;
        remote: boolean;
        resolvedType: string;
        valuesByMode: Record<string, unknown>;
        description: string;
        scopes?: string[];
      }
    >;
  };
}

export interface FigmaVersion {
  id: string;
  created_at: string;
  label?: string;
  description?: string;
  user: { id: string; handle: string };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const FIGMA_BASE_URL = 'https://api.figma.com';

/**
 * Minimal client over the Figma REST API.
 * Auth is X-Figma-Token header from the FIGMA_TOKEN env var.
 */
export class FigmaClient {
  private readonly token: string;

  constructor() {
    const token = process.env.FIGMA_TOKEN?.trim();
    if (!token) {
      throw new Error(
        'FIGMA_TOKEN env var is required. Generate a personal access token at https://www.figma.com/developers/api#authentication and add it to .env',
      );
    }
    this.token = token;
  }

  private async request<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${FIGMA_BASE_URL}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        'X-Figma-Token': this.token,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Figma API error (${response.status}): ${body}`);
    }

    return response.json() as Promise<T>;
  }

  /** Get the authenticated user's profile. */
  async getMe(): Promise<FigmaUser> {
    return this.request<FigmaUser>('/v1/me');
  }

  /** Get a file by its key. */
  async getFile(fileKey: string): Promise<FigmaFileResponse> {
    return this.request<FigmaFileResponse>(`/v1/files/${encodeURIComponent(fileKey)}`);
  }

  /** Get specific nodes from a file by their IDs. */
  async getNodes(fileKey: string, ids: string): Promise<FigmaNodesResponse> {
    return this.request<FigmaNodesResponse>(`/v1/files/${encodeURIComponent(fileKey)}/nodes`, { ids });
  }

  /** Export images for specific nodes. */
  async getImages(
    fileKey: string,
    ids: string,
    format?: string,
    scale?: number,
  ): Promise<FigmaImagesResponse> {
    return this.request<FigmaImagesResponse>(`/v1/images/${encodeURIComponent(fileKey)}`, {
      ids,
      format,
      scale,
    });
  }

  /** Get comments on a file. */
  async getComments(fileKey: string): Promise<FigmaComment[]> {
    const data = await this.request<{ comments: FigmaComment[] }>(
      `/v1/files/${encodeURIComponent(fileKey)}/comments`,
    );
    return data.comments;
  }

  /** Get styles published to a file. */
  async getStyles(fileKey: string): Promise<FigmaStyle[]> {
    const data = await this.request<{ error: boolean; status: number; meta: { styles: FigmaStyle[] } }>(
      `/v1/files/${encodeURIComponent(fileKey)}/styles`,
    );
    return data.meta.styles;
  }

  /** Get local variables in a file. */
  async getVariables(fileKey: string): Promise<FigmaVariablesResponse> {
    return this.request<FigmaVariablesResponse>(`/v1/files/${encodeURIComponent(fileKey)}/variables/local`);
  }

  /** Get version history of a file. */
  async getVersions(fileKey: string): Promise<FigmaVersion[]> {
    const data = await this.request<{ versions: FigmaVersion[]; pagination?: unknown }>(
      `/v1/files/${encodeURIComponent(fileKey)}/versions`,
    );
    return data.versions;
  }
}
