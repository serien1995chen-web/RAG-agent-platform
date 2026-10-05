/** 设计文档 6.9：非法配置在启动时失败，退出码 20-29。 */
export class ConfigValidationException extends Error {
  readonly exitCode = 20;
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`配置校验失败（${issues.length} 项）: ${issues.join('; ')}`);
    this.name = 'ConfigValidationException';
    this.issues = issues;
  }
}
