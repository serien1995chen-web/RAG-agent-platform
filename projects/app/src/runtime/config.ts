import { loadConfigFromEnv, type AppConfig } from '@kb/service';

let cached: AppConfig | undefined;

/** 配置只在进程内校验一次；非法配置抛出 ConfigValidationException（退出码 20）。 */
export function getAppConfig(): AppConfig {
  if (!cached) cached = loadConfigFromEnv();
  return cached;
}
