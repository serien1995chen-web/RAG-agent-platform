import { expect, type Page } from '@playwright/test';

export async function chooseDifferentModel(page: Page, label: string) {
  const trigger = page.locator(`button:visible[aria-label^="${label}"]`).last();
  await expect(trigger).toBeVisible();
  await trigger.click();
  const listbox = page.getByRole('listbox', { name: label }).last();
  await expect(listbox).toBeVisible();
  const option = listbox
    .locator('[role="option"][aria-selected="false"]:visible')
    .filter({ hasNotText: /未设置|不设置/ })
    .first();
  if ((await option.count()) === 0) {
    await page.keyboard.press('Escape');
    return null;
  }
  const selectedText = (await option.innerText()).trim();
  await option.click({ force: true });
  await expect(listbox).toHaveCount(0);
  return selectedText;
}
