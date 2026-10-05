import type { DtoSpec } from './schema-compiler';

/**
 * 12.8.2 未登记但被 RebuildEmbeddingBody 引用的值对象（设计文档 7.3）。
 * 作为派生 DTO 登记，避免 DTO 闭包出现未定义引用；实现在 common/primitives。
 */
export const DERIVED_DTO_SPECS: readonly DtoSpec[] = [
  {
    name: 'ModelReference',
    section: '7.3-derived',
    fields:
      'provider:string(1-64,required); model:string(1-128,required); dimension:number(required); capability:string(1-64,optional)',
  },
];
