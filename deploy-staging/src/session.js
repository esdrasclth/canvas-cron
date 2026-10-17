const { chromium } = require('playwright');
const config = require('./config');
const { ensureDataDirectories, exists } = require('./storage');

class InteractionRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InteractionRequiredError';
    this.code = 'INTERACTION_REQUIRED';
  }
}

async function visible(locator, timeout = 1500) {
  return locator.first().isVisible({ timeout }).catch(() => false);
}

async function refreshSession() {
  await ensureDataDirectories();
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    viewport: { width: 1440, height: 900 },
  });

  try {
    if (await exists(config.authFile)) {
      const savedState = JSON.parse(await require('node:fs/promises').readFile(config.authFile, 'utf8'));
      if (savedState.cookies?.length) await context.addCookies(savedState.cookies);
    }
    const page = await context.newPage();
    await page.goto(config.portalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    let canvasLink = page.getByText('Canvas', { exact: true }).first();
    if (!await visible(canvasLink)) {
      const institutionLogin = page.getByText(/cuenta de correo/i).first();
      if (await visible(institutionLogin)) {
        await institutionLogin.click();
        await page.waitForLoadState('domcontentloaded');
      }

      const emailInput = page.locator('input[type="email"]').first();
      if (await visible(emailInput, 5_000)) {
        if (!config.unitEmail) throw new InteractionRequiredError('Falta UNITEC_EMAIL');
        await emailInput.fill(config.unitEmail);
        await page.locator('input[type="submit"]').first().click();
      }

      const passwordInput = page.locator('input[type="password"]').first();
      if (await visible(passwordInput, 10_000)) {
        if (!config.unitPassword) throw new InteractionRequiredError('Falta UNITEC_PASSWORD');
        await passwordInput.fill(config.unitPassword);
        await page.locator('input[type="submit"]').first().click();
      }

      await page.waitForTimeout(2500);
      const staySignedIn = page.getByText(/mantener.*sesión|stay signed in/i).first();
      if (await visible(staySignedIn)) {
        const yes = page.locator('input[type="submit"]').first();
        if (await visible(yes)) await yes.click();
      }

      await page.waitForURL(/portal\.unitec\.edu/, { timeout: 30_000 }).catch(() => {});
      canvasLink = page.getByText('Canvas', { exact: true }).first();
    }

    if (!await visible(canvasLink, 10_000)) {
      throw new InteractionRequiredError(`Microsoft requiere intervención en ${page.url()}`);
    }

    const knownPages = context.pages();
    await canvasLink.click();
    await page.waitForTimeout(2000);
    const canvasPage = context.pages().find((candidate) => !knownPages.includes(candidate)) ?? context.pages().at(-1);
    await canvasPage.waitForURL(/unitechonduras\.instructure\.com/, { timeout: 30_000 });
    await context.storageState({ path: config.authFile });
    return { url: canvasPage.url(), refreshed: true };
  } finally {
    await context.close();
  }
}

module.exports = { InteractionRequiredError, refreshSession };
