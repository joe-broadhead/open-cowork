declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean })
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }

  export interface StatementSync {
    run(...params: any[]): unknown
    get(...params: any[]): unknown
    all(...params: any[]): unknown[]
  }
}
