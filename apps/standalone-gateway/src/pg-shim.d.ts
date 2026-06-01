declare module "pg" {
  export class Pool {
    constructor(options?: { connectionString?: string; max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number });
    query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
    end(): Promise<void>;
  }
}
