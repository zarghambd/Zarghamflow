import { expect, test } from '@playwright/test';

test('a new user can sign in with OTP and create persistent tasks and meetings', async ({ page }) => {
  test.setTimeout(45_000);
  const email = `smoke-${Date.now()}@example.test`;
  const taskTitle = `Playwright task ${Date.now()}`;

  await page.route('**/service-worker.js*', (route) => route.abort());
  await page.goto('/signin');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send me a sign-in code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();

  let otp = '';
  await expect.poll(async () => {
    const response = await page.request.get(`http://127.0.0.1:3002/latest-code?email=${encodeURIComponent(email)}`);
    if (!response.ok()) return '';
    otp = (await response.json() as { code: string }).code;
    return otp;
  }, { timeout: 20_000 }).toMatch(/^\d{6}$/);
  const [verified] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/auth/verify')),
    page.getByLabel('6-digit code').fill(otp)
  ]);
  expect(verified.status()).toBe(200);
  await expect(page).toHaveURL(/\/planner$/);
  await expect(page.locator('.offline')).toHaveText('Synced');
  await page.waitForLoadState('networkidle');

  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await page.locator('#app button[data-action="new-task"]').first().click();
  await expect(page.locator('#dialog')).toBeVisible();
  await page.locator('#dialog input[name="title"]').fill(taskTitle);
  const [taskCreated] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/tasks')),
    page.getByRole('button', { name: 'Create' }).click()
  ]);
  expect(taskCreated.status()).toBe(201);
  await expect(page.locator('#app')).toContainText(taskTitle);

  const meetingTitle = `Playwright meeting ${Date.now()}`;
  await page.locator('#app button[data-action="new-meeting"]').first().click();
  await expect(page.locator('#dialog')).toBeVisible();
  await page.locator('#dialog input[name="title"]').fill(meetingTitle);
  const [meetingCreated] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/meetings')),
    page.getByRole('button', { name: 'Create' }).click()
  ]);
  expect(meetingCreated.status()).toBe(201);
  await page.reload();
  await expect(page.locator('#app')).toContainText(taskTitle);
  await expect(page.locator('#app')).toContainText(meetingTitle);
  const pendingOutbox = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('zarghamflow-offline-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction('outbox', 'readonly');
      const count = transaction.objectStore('outbox').count();
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => reject(count.error);
    };
  }));
  expect(pendingOutbox).toBe(0);

  const unsyncedTitle = `Offline task ${Date.now()}`;
  await page.context().route('**/api/v1/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } }) });
    } else {
      await route.continue();
    }
  });
  await page.context().setOffline(true);
  await page.locator('#app button[data-action="new-task"]').first().click();
  await expect(page.locator('#dialog')).toBeVisible();
  await page.locator('#dialog input[name="title"]').fill(unsyncedTitle);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('#app')).toContainText(unsyncedTitle);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  const failedSync = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/tasks'));
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect((await failedSync).status()).toBe(401);
  await expect(page.locator('.banner[role="alert"]')).toContainText('Sign in again before syncing this saved change.');
  const retainedOutbox = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('zarghamflow-offline-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction('outbox', 'readonly');
      const count = transaction.objectStore('outbox').count();
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => reject(count.error);
    };
  }));
  expect(retainedOutbox).toBe(1);
  const retriedSync = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/tasks'));
  await page.getByRole('button', { name: 'Retry sync' }).click();
  expect((await retriedSync).status()).toBe(401);
  await expect(page.locator('.banner[role="alert"]')).toContainText('Sign in again before syncing this saved change.');
  await page.getByRole('button', { name: 'Discard local change' }).click();
  await expect(page.locator('#app')).not.toContainText(unsyncedTitle);
});
