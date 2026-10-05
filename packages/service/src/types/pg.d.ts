/**
 * 本地最小类型声明：设计文档 6.1 未登记 @types/pg，构建设计不引入未登记依赖。
 * 仅覆盖本项目使用的 pg 子集（Pool/Client/QueryResult）；登记上游类型前不得扩展。
 */
declare module 'pg' {
  export interface QueryResult<Row = Record<string, unknown>> {
    rows: Row[];
    rowCount: number | null;
  }

  export interface PoolConfig {
    connectionString?: string;
    max?: number;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    on(event: 'error', listener: (error: unknown) => void): this;
    query<Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>>;
    end(): Promise<void>;
  }

  export class Client {
    constructor(config?: PoolConfig);
    on(event: 'error', listener: (error: unknown) => void): this;
    connect(): Promise<void>;
    query<Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>>;
    end(): Promise<void>;
  }
}
