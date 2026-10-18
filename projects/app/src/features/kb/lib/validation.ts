/** 前端表单/文件校验错误；与 API 错误区分，不进入统一错误工厂。 */
export class KbValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbValidationError';
  }
}
