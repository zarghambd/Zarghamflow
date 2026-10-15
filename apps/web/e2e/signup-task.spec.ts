import { expect, test } from '@playwright/test';

test('a new user can sign up and create a task', async ({ page }) => {
  test.setTimeout(45_000);
  const email = `smoke-${Date.now()}@example.test`;
  const taskTitle = `Playwright task ${Date.now()}`;

  await page.goto('/signin');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Email me a secure link' }).click();

  const developmentLink = page.getByRole('link', { name: 'Continue using the local sign-in link' });
  await expect(developmentLink).toBeVisible({ timeout: 20_000 });
  await developmentLink.click();
  await expect(page).toHaveURL(/\/planner$/);

  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await page.getByRole('textbox', { name: 'Quick add task' }).fill(taskTitle);
  const [created] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/v1/tasks/quick-add')),
    page.getByRole('button', { name: 'Add task' }).click()
  ]);
  expect(created.status()).toBe(201);

  await expect(page.locator('#app')).toContainText(taskTitle);
});
