import { test, expect } from '@playwright/test';

// NOTE — fixture setup required (see backlog #50):
//
// This test depends on a seeded service ticket + customer + part + unit being
// present in the test Supabase database. Until a fixture script exists, run
// this test manually after seeding:
//   1. Insert a service_tickets row with subject='E2E-TICKET-REPL', customer_id linked
//   2. Insert a parts row with name='E2E-PART', on_hand=10, category='replacement'
//   3. Insert a units row with serial='LL01-E2E', status='ready', batch='B7'
//   4. Set the auth user to a profiles.is_internal=true account
//
// Auth: existing e2e tests are unauthenticated smoke tests only — no login helper
// exists yet. When a login helper is added (e.g., tests/e2e/helpers/auth.ts),
// replace the inline auth block below with it.
//
// Once a fixture seeder is added, remove the test.skip() below.

test.describe('Replacement workflow', () => {
  test.skip(true, 'requires fixture seeding (see backlog #50 + comment above)');

  test('ticket → modal → order → fulfillment → delivered → ticket closed', async ({ page }) => {
    // 1. Sign in (inline — no auth helper exists yet; replace when one is added)
    await page.goto('/login');
    // Real Google OAuth cannot be driven headlessly; a future login helper should
    // inject a valid Supabase session cookie or use a test-mode magic-link flow.
    // Placeholder: navigate directly once session is injected externally.
    await page.goto('/');

    // 2. Open Service → click the seeded ticket → Send replacement
    await page.getByText('Service').click();
    await page.getByText('Inbox').click();
    await page.getByText('E2E-TICKET-REPL').click();
    await page.getByRole('button', { name: /send replacement/i }).click();

    // 3. Modal: search + pick a part + a unit, fill in shipping cost, confirm
    const searchBox = page.getByPlaceholder(/search parts or units/i);
    await searchBox.fill('E2E-PART');
    await page.getByText('E2E-PART').click();
    await searchBox.fill('LL01-E2E');
    await page.getByText('LL01-E2E').click();
    await page.getByRole('button', { name: /create replacement order/i }).click();

    // 4. Order Review: confirm the Replacement badge + originating-ticket link
    await expect(page.getByText('Replacement order')).toBeVisible();
    const orderRefLocator = page.locator('text=/R-\\d{4}/').first();
    const orderRef = await orderRefLocator.textContent();
    if (!orderRef || !/^R-\d{4}$/.test(orderRef)) {
      throw new Error(`Expected an R-XXXX order ref, got ${orderRef}`);
    }

    // Approve the order so it flows to Fulfillment
    await page.getByRole('button', { name: /approve/i }).click();

    // 5. Fulfillment: walk to the email step, enter shipping cost, send
    await page.getByText('Fulfillment').click();
    await page.getByText(orderRef!).click();
    // Walk to the email step — implementation may vary
    await page.getByLabel(/actual shipping cost/i).fill('42.75');
    await page.getByRole('button', { name: /send/i }).click();

    // 6. Post-Shipment: find the awaiting-delivery row, mark delivered
    await page.getByText('Post-Shipment').click();
    await page.getByText('History').click();
    const row = page.locator(`tr:has-text("${orderRef}")`);
    await row.getByRole('button', { name: /mark delivered/i }).click();

    // 7. Service: ticket should now be closed
    await page.getByText('Service').click();
    await page.getByText('Inbox').click();
    // Filter to closed status
    await page.getByRole('button', { name: /closed/i }).click();
    await expect(page.getByText('E2E-TICKET-REPL')).toBeVisible();
  });
});
