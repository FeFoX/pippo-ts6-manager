import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Express } from 'express';
import { settingsRoutes } from './settings.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { loadBotControlGroups, loadSeekCooldownSec } from '../utils/app-settings.js';

function fakePrisma() {
  const settings = new Map<string, string>();
  const audit: Array<Record<string, unknown>> = [];
  const prisma: any = {
    appSetting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      findMany: async ({ where }: any) => [...settings].filter(([k]) => where.key.in.includes(k)).map(([key, value]) => ({ key, value })),
      upsert: async ({ where, create, update }: any) => {
        settings.set(where.key, settings.has(where.key) ? update.value : create.value);
      },
    },
    adminAuditEvent: {
      create: async ({ data }: any) => { audit.push(data); return { id: 'a1', ...data }; },
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, settings, audit };
}

async function serve(role: 'admin' | 'viewer', prisma: unknown) {
  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role, username: 'u' };
    req.app.locals.prisma = prisma;
    next();
  });
  app.use('/api/settings', settingsRoutes);
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  return { base: `http://127.0.0.1:${port}/api/settings`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const put = (url: string, body: unknown) =>
  fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('bot access and seek cooldown settings', () => {
  it('stores the control groups, audits the change, and the bot-side loader sees it at once', async () => {
    const { prisma, audit } = fakePrisma();
    const s = await serve('admin', prisma);
    try {
      assert.deepEqual(await (await fetch(`${s.base}/bot-access`)).json(), { controlGroups: [] });
      const res = await put(`${s.base}/bot-access`, { controlGroups: [' Music Bot Controllers ', 'music bot controllers', '102'] });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { controlGroups: ['Music Bot Controllers', '102'] });
      assert.deepEqual(await (await fetch(`${s.base}/bot-access`)).json(), { controlGroups: ['Music Bot Controllers', '102'] });
      assert.deepEqual(await loadBotControlGroups(prisma), ['Music Bot Controllers', '102']);
      assert.equal(audit[0].action, 'settings.bot_access_update');
      await put(`${s.base}/bot-access`, { controlGroups: [] });
      assert.deepEqual(await loadBotControlGroups(prisma), [], 'cleared: everybody again');
    } finally { await s.close(); }
  });

  it('rejects a malformed group list and leaves the setting alone', async () => {
    const { prisma, settings } = fakePrisma();
    const s = await serve('admin', prisma);
    try {
      assert.equal((await put(`${s.base}/bot-access`, { controlGroups: 'Music Bot Controllers' })).status, 400);
      assert.equal((await put(`${s.base}/bot-access`, {})).status, 400);
      assert.equal(settings.size, 0);
    } finally { await s.close(); }
  });

  it('only admins can read or change the access list', async () => {
    const { prisma } = fakePrisma();
    const s = await serve('viewer', prisma);
    try {
      assert.equal((await fetch(`${s.base}/bot-access`)).status, 403);
      assert.equal((await put(`${s.base}/bot-access`, { controlGroups: ['x'] })).status, 403);
      assert.equal((await put(`${s.base}/limits`, { seekCooldownSeconds: 0 })).status, 403);
    } finally { await s.close(); }
  });

  it('shows two minutes until changed, then follows the saved value (0 = no limit)', async () => {
    const { prisma } = fakePrisma();
    const s = await serve('admin', prisma);
    try {
      assert.equal((await (await fetch(`${s.base}/limits`)).json()).seekCooldownSeconds, 120);
      assert.equal((await put(`${s.base}/limits`, { seekCooldownSeconds: 45 })).status, 200);
      assert.equal((await (await fetch(`${s.base}/limits`)).json()).seekCooldownSeconds, 45);
      assert.equal(await loadSeekCooldownSec(prisma), 45);
      assert.equal((await put(`${s.base}/limits`, { seekCooldownSeconds: 0 })).status, 200);
      assert.equal(await loadSeekCooldownSec(prisma), 0);
    } finally { await s.close(); }
  });

  it('refuses a cooldown that is negative, fractional, text or absurdly long', async () => {
    const { prisma } = fakePrisma();
    const s = await serve('admin', prisma);
    try {
      for (const bad of [-1, 1.5, 'soon', 86_401]) {
        assert.equal((await put(`${s.base}/limits`, { seekCooldownSeconds: bad })).status, 400, String(bad));
      }
      assert.equal(await loadSeekCooldownSec(prisma), 120);
    } finally { await s.close(); }
  });
});
