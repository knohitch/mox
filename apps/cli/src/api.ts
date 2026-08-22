/**
 * Mox CLI (Prompt 10). Talks only to public Mox APIs; it never bypasses
 * policy or entitlements — every privileged action is validated server-side.
 */

export interface ApiClient {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
}

export class HttpApiClient implements ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenProvider: () => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.tokenProvider();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`API ${method} ${path} failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined;
    return res.json();
  }
}

/** Token persistence seam (file-backed in production, memory in tests). */
export interface TokenStore {
  get(): Promise<string | undefined>;
  set(token: string | undefined): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private token?: string;
  async get(): Promise<string | undefined> {
    return this.token;
  }
  async set(token: string | undefined): Promise<void> {
    this.token = token;
  }
}

export interface CliIo {
  print(line: string): void;
  error(line: string): void;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
