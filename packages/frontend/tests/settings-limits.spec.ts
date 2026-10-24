import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

/** Serves Settings → YouTube → Download & Stream Limits from memory and records what is saved. */
async function stubLimits(page: Page, stored: Record<string, unknown>) {
  const saved: Array<Record<string, unknown>> = [];
  await page.route('**/api/settings/limits', async (route) => {
    if (route.request().method() === 'PUT') {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { ...stored, ...route.request().postDataJSON() } });
    }
    return route.fulfill({ json: stored });
  });
  return saved;
}

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('limits card shows the stored seek and resume cooldowns and saves them as numbers', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  const saved = await stubLimits(page, {
    maxVideoDuration: 900, maxPlaylistImport: 250, youtubeDirectStream: false,
    seekCooldownSeconds: 45, resumeCooldownSeconds: 7,
  });
  await page.goto('/settings?tab=youtube');
  const seek = page.getByLabel(/^Seek cooldown for remote sources/);
  const resume = page.getByLabel(/^Resume cooldown for paused videos/);
  await expect(seek).toHaveValue('45');
  await expect(resume).toHaveValue('7');

  await seek.fill('0');
  await resume.fill('3600');
  await page.getByRole('button', { name: 'Save Limits' }).click();
  await expect(page.getByText('Limits saved')).toBeVisible();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ seekCooldownSeconds: 0, resumeCooldownSeconds: 3600 });
});

test('limits card falls back to the defaults when the server sends no cooldowns', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  await stubLimits(page, { maxVideoDuration: 900, maxPlaylistImport: 250, youtubeDirectStream: false });
  await page.goto('/settings?tab=youtube');
  await expect(page.getByLabel(/^Seek cooldown for remote sources/)).toHaveValue('120');
  await expect(page.getByLabel(/^Resume cooldown for paused videos/)).toHaveValue('10');
});

test('an invalid seek or resume cooldown blocks saving and says why', async ({ page, request }) => {
  await signInAsAdmin(page, request);
  const saved = await stubLimits(page, {
    maxVideoDuration: 900, maxPlaylistImport: 250, youtubeDirectStream: false,
    seekCooldownSeconds: 120, resumeCooldownSeconds: 10,
  });
  await page.goto('/settings?tab=youtube');
  const seek = page.getByLabel(/^Seek cooldown for remote sources/);
  const resume = page.getByLabel(/^Resume cooldown for paused videos/);
  const save = page.getByRole('button', { name: 'Save Limits' });
  await expect(save).toBeEnabled();

  for (const bad of ['', '-1', '1.5', '86401']) {
    await seek.fill(bad);
    await expect(seek).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'from 0 to 86400' })).toBeVisible();
    await expect(save).toBeDisabled();
  }
  await seek.fill('120');
  await expect(save).toBeEnabled();

  for (const bad of ['', '-1', '1.5', '3601']) {
    await resume.fill(bad);
    await expect(resume).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'from 0 to 3600' })).toBeVisible();
    await expect(save).toBeDisabled();
  }
  await resume.fill('3600');
  await expect(save).toBeEnabled();
  expect(saved).toHaveLength(0);
});
