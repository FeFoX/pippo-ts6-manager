import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SeekRateLimitedError, SeekUnsupportedError } from '../voice/voice-bot.js';

/** Bot Flow "Voice Seek" goes on without the seek when the bot cannot or may not do it now. */
async function seekWith(failure: Error | null) {
  const { FlowRunner } = await import('./flow-runner.js');
  const runner = new FlowRunner({} as any, {} as any, { clients: new Set() } as any) as any;
  const bot = { seek: async () => { if (failure) throw failure; } };
  runner.setVoiceBotManager({ getBot: () => bot });
  const ctx = { resolveTemplate: async (value: unknown) => String(value) };
  return runner.executeVoiceSeek({ botId: '3', position: '165' }, ctx);
}

test('a flow skips a seek the bot refused as too soon or as unsupported, and fails on anything else', async () => {
  await seekWith(null);
  await seekWith(new SeekRateLimitedError(30, 120));
  await seekWith(new SeekUnsupportedError());
  await assert.rejects(seekWith(new Error('boom')), /boom/);
});
