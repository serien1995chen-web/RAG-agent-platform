import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export interface UiBrowserErrors {
  console: string[];
  page: string[];
  requests: string[];
}

export function collectBrowserErrors(page: Page): UiBrowserErrors {
  const errors: UiBrowserErrors = {
    console: [],
    page: [],
    requests: [],
  };
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', (error) => errors.page.push(error.message));
  page.on('requestfailed', (request) => {
    errors.requests.push(
      `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? 'failed'}`,
    );
  });
  return errors;
}

export async function assertNoOverflow(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter(
        (element) =>
          element.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
      )
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        className: String(element.className).slice(0, 120),
        text: element.textContent?.trim().slice(0, 80) ?? '',
      })),
  }));
  expect(state.overflow, JSON.stringify(state.offenders)).toBeLessThanOrEqual(1);
}

export async function assertShell(page: Page): Promise<void> {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

export async function assertAxe(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
}

export async function assertFocusable(page: Page): Promise<void> {
  const focusable = await page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).length,
  );
  expect(focusable).toBeGreaterThan(0);
}

export async function assertNoDeferredNavigation(page: Page): Promise<void> {
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
  expect(hrefs).not.toContain('/usage');
  expect(hrefs).not.toContain('/audit');
  expect(hrefs).not.toContain('/settings/api-keys');
}

export async function assertSkipLink(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Tab');
  const state = await page.evaluate(() => {
    const skip = document.querySelector<HTMLElement>('.skip-link');
    if (!skip) return { found: false, focused: false, target: null as string | null };
    return {
      found: getComputedStyle(skip).display !== 'none',
      focused: document.activeElement === skip,
      target: skip.getAttribute('href'),
    };
  });
  expect(state.found).toBe(true);
  expect(state.target).toBe('#main-content');
}

export async function assertKeyboardFlow(page: Page): Promise<void> {
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? null);
  expect(focused).not.toBeNull();
}

export async function assertFocusReturn(page: Page, triggerSelector: string): Promise<void> {
  const trigger = page.locator(triggerSelector).first();
  await trigger.focus();
  await trigger.press('Enter');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
}

export function assertBrowserErrors(errors: UiBrowserErrors): void {
  expect(errors.console).toEqual([]);
  expect(errors.page).toEqual([]);
  expect(errors.requests).toEqual([]);
}
