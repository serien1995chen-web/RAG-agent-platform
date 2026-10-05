import { DEFAULT_LOCALE, MESSAGES, type Locale } from './messages';

/** 用 params 插值 messageKey；缺失时退化为 key 本身，避免伪造文案。 */
export function translate(
  key: string,
  params: Record<string, unknown> = {},
  locale: Locale = DEFAULT_LOCALE,
): string {
  const template = MESSAGES[locale][key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? '' : String(value);
  });
}
