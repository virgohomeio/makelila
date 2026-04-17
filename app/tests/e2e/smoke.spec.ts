import { test, expect } from '@playwright/test';

test('unauthenticated user is redirected to login', async ({ page }) => {
  await page.goto('order-review');
  await expect(page).toHaveURL(/\/login/);
  await expect(
    page.getByRole('button', { name: /sign in with google/i }),
  ).toBeVisible();
});

test('login page shows brand heading', async ({ page }) => {
  await page.goto('login');
  await expect(page.getByRole('heading', { name: /make lila/i })).toBeVisible();
});
