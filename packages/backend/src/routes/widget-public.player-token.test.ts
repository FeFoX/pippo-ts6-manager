import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { widgetPublicRoutes, playerWidgetToken } from './widget-public.routes.js';

async function get(path: string) {
  const app = express();
  app.locals.voiceBotManager = { getBot: () => null };
  app.use('/api/widget', widgetPublicRoutes);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as { port: number };
  try {
    return (await fetch(`http://127.0.0.1:${port}${path}`)).status;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('player widget token', () => {
  for (const kind of ['data', 'bbcode']) {
    it(`/${kind} accepts the bot's token and refuses anything else`, async () => {
      const token = playerWidgetToken(7);
      // 404 means the token passed and the (absent) bot was looked up.
      assert.equal(await get(`/api/widget/player/7/${kind}?token=${token}`), 404);
      assert.equal(await get(`/api/widget/player/7/${kind}?token=${playerWidgetToken(8)}`), 403);
      assert.equal(await get(`/api/widget/player/7/${kind}?token=${token.slice(0, -1)}`), 403);
      assert.equal(await get(`/api/widget/player/7/${kind}?token=${token}&token=${token}`), 403);
      assert.equal(await get(`/api/widget/player/7/${kind}`), 403);
    });
  }
});
