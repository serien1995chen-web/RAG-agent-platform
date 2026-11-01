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

export async function assertNoOverflow(page: Page): Promise<number> {
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
  return state.overflow;
}

export async function assertShell(page: Page): Promise<void> {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

export async function assertAxe(
  page: Page,
): Promise<{ serious: number; critical: number; violations: number }> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blocking).toEqual([]);
  return {
    serious: blocking.filter((violation) => violation.impact === 'serious').length,
    critical: blocking.filter((violation) => violation.impact === 'critical').length,
    violations: result.violations.length,
  };
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

export async function assertAuthorizedNavigation(page: Page, authorized = true): Promise<void> {
  for (const href of ['/usage', '/audit', '/settings/api-keys']) {
    await expect(page.locator(`nav a[href="${href}"]`)).toHaveCount(authorized ? 1 : 0);
  }
}

export async function assertSkipLink(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Tab');
  const state = await page.evaluate(() => {
    const skip = document.querySelector<HTMLElement>('.skip-link');
    if (!skip) {
      return {
        found: false,
        focused: false,
        target: null as string | null,
        mainExists: false,
      };
    }
    const style = getComputedStyle(skip);
    return {
      found: true,
      focused: document.activeElement === skip,
      target: skip.getAttribute('href'),
      mainExists:
        skip.getAttribute('href') === '#knowledge-main' &&
        Boolean(document.querySelector('#knowledge-main')),
      visible: style.opacity !== '0' && style.pointerEvents !== 'none',
    };
  });
  expect(state).toMatchObject({
    found: true,
    focused: true,
    target: '#knowledge-main',
    mainExists: true,
    visible: true,
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('#knowledge-main')).toBeFocused();
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
