/**
 * pgvector 子目录出口（P2-04）。
 * persistence/index.ts 与 shared/index.ts 由后续任务负责装配，本任务不修改汇编 barrel。
 */
export { PGVECTOR_DDL_STATEMENTS, PGVECTOR_DIMENSION, ensurePgvectorDdl } from './ddl';
export { PgVectorRepository } from './vector-repository';
