import { test, expect } from '@playwright/test';

test('unauthed /order-review redirects to /login', async ({ page }) => {
  await page.goto('order-review');
  await expect(page).toHaveURL(/\/login/);
});

test('unauthed /order-review/:id redirects to /login', async ({ page }) => {
  await page.goto('order-review/00000000-0000-0000-0000-000000000000');
  await expect(page).toHaveURL(/\/login/);
});
