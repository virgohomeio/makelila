import { test, expect } from '@playwright/test';

test('unauthed /fulfillment redirects to /login', async ({ page }) => {
  await page.goto('fulfillment');
  await expect(page).toHaveURL(/\/login/);
});

test('unauthed /fulfillment/shelf redirects to /login', async ({ page }) => {
  await page.goto('fulfillment/shelf');
  await expect(page).toHaveURL(/\/login/);
});
