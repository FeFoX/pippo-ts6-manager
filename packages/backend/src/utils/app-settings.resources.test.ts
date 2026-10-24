import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VIDEO_CONVERT_THREADS_KEY,
  VIDEO_CPU_PRIORITY_KEY,
  VIDEO_ENCODE_THREADS_KEY,
  applyBotResourceUpdate,
  loadBotResourceSettings,
  loadVideoStreamingSettings,
  parseBotResourceOverrides,
  parseServerOverrides,
  parseVideoStreamingSettings,
  parseVideoStreamingUpdate,
  videoBotOverridesKey,
  videoServerOverridesKey,
} from './app-settings.js';
import { parseStreamStartOptions } from '../voice/streaming/start-options.js';

function prismaWith(rows: Record<string, string>) {
  return {
    appSetting: {
      findMany: async ({ where }: any) => Object.entries(rows)
        .filter(([key]) => where.key.in.includes(key))
        .map(([key, value]) => ({ key, value })),
      findUnique: async ({ where }: any) => (where.key in rows ? { key: where.key, value: rows[where.key] } : null),
    },
  } as any;
}

describe('convert threads and CPU priority settings', () => {
  it('are automatic and normal until an admin sets them', () => {
    const s = parseVideoStreamingSettings(new Map());
    assert.equal(s.convertThreads, 0);
    assert.equal(s.cpuPriority, 'normal');
  });

  it('read a stored value and ignore one out of range', () => {
    const s = parseVideoStreamingSettings(new Map([[VIDEO_CONVERT_THREADS_KEY, '4'], [VIDEO_CPU_PRIORITY_KEY, 'lowest']]));
    assert.equal(s.convertThreads, 4);
    assert.equal(s.cpuPriority, 'lowest');
    for (const bad of ['65', '-1', 'x', '2.5']) {
      assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_CONVERT_THREADS_KEY, bad]])).convertThreads, 0, bad);
    }
    for (const bad of ['high', '', 'LOW']) {
      assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_CPU_PRIORITY_KEY, bad]])).cpuPriority, 'normal', bad);
    }
  });

  it('are saved from the settings page and refuse anything else', () => {
    assert.deepEqual(parseVideoStreamingUpdate({ convertThreads: 3 }), {
      ok: true, rows: [{ key: VIDEO_CONVERT_THREADS_KEY, value: '3' }],
    });
    assert.deepEqual(parseVideoStreamingUpdate({ cpuPriority: 'low' }), {
      ok: true, rows: [{ key: VIDEO_CPU_PRIORITY_KEY, value: 'low' }],
    });
    for (const bad of [65, -1, 'many', 2.5]) assert.equal(parseVideoStreamingUpdate({ convertThreads: bad }).ok, false, String(bad));
    for (const bad of ['high', 1, null, true]) assert.equal(parseVideoStreamingUpdate({ cpuPriority: bad }).ok, false, String(bad));
  });

  it('can be set for one server only', () => {
    assert.deepEqual(parseServerOverrides({ convertThreads: 2, cpuPriority: 'low' }), { convertThreads: 2, cpuPriority: 'low' });
    assert.deepEqual(parseServerOverrides({ convertThreads: 99, cpuPriority: 'high' }), {});
  });
});

describe('a bot\'s own resource overrides', () => {
  it('keep only valid fields', () => {
    assert.deepEqual(parseBotResourceOverrides('{"encodeThreads":2,"convertThreads":0,"cpuPriority":"low","x":1}'),
      { encodeThreads: 2, convertThreads: 0, cpuPriority: 'low' });
    assert.deepEqual(parseBotResourceOverrides('{"encodeThreads":99,"cpuPriority":"high"}'), {});
    assert.deepEqual(parseBotResourceOverrides('not json'), {});
    assert.deepEqual(parseBotResourceOverrides(undefined), {});
  });

  it('are changed by a PUT body: values set, null clears, a missing field stays', () => {
    const current = { encodeThreads: 2, cpuPriority: 'low' as const };
    const r = applyBotResourceUpdate(current, { convertThreads: 0, encodeThreads: null });
    assert.deepEqual(r, { ok: true, overrides: { convertThreads: 0, cpuPriority: 'low' } });
    assert.deepEqual(applyBotResourceUpdate(current, { cpuPriority: null }), { ok: true, overrides: { encodeThreads: 2 } });
    for (const body of [{ encodeThreads: 65 }, { convertThreads: 'x' }, { cpuPriority: 'high' }, {}, null]) {
      assert.equal(applyBotResourceUpdate(current, body as any).ok, false, JSON.stringify(body));
    }
  });

  it('win over the server, which wins over the global setting', async () => {
    const rows: Record<string, string> = {
      [VIDEO_ENCODE_THREADS_KEY]: '6',
      [VIDEO_CONVERT_THREADS_KEY]: '3',
      [VIDEO_CPU_PRIORITY_KEY]: 'normal',
      [videoServerOverridesKey(1)]: JSON.stringify({ encodeThreads: 4, cpuPriority: 'low' }),
      [videoBotOverridesKey(7)]: JSON.stringify({ encodeThreads: 2 }),
    };
    const prisma = prismaWith(rows);
    // The bot sets only encode threads; the server's priority and the global convert threads still apply.
    const bot7 = await loadVideoStreamingSettings(prisma, 1, 7);
    assert.deepEqual([bot7.encodeThreads, bot7.convertThreads, bot7.cpuPriority], [2, 3, 'low']);
    // Another bot of the same server gets the server's value; no server gets the global one.
    const bot8 = await loadVideoStreamingSettings(prisma, 1, 8);
    assert.deepEqual([bot8.encodeThreads, bot8.convertThreads, bot8.cpuPriority], [4, 3, 'low']);
    const none = await loadVideoStreamingSettings(prisma);
    assert.deepEqual([none.encodeThreads, none.convertThreads, none.cpuPriority], [6, 3, 'normal']);
    // An explicit 0 (automatic) on the bot beats a nonzero default above it.
    rows[videoBotOverridesKey(7)] = JSON.stringify({ encodeThreads: 0, cpuPriority: 'normal' });
    const auto = await loadVideoStreamingSettings(prisma, 1, 7);
    assert.deepEqual([auto.encodeThreads, auto.cpuPriority], [0, 'normal']);
  });

  it('are reported with what the bot gets from them', async () => {
    const prisma = prismaWith({
      [VIDEO_ENCODE_THREADS_KEY]: '6',
      [videoBotOverridesKey(7)]: JSON.stringify({ cpuPriority: 'lowest' }),
    });
    assert.deepEqual(await loadBotResourceSettings(prisma, 1, 7), {
      overrides: { cpuPriority: 'lowest' },
      effective: { encodeThreads: 6, convertThreads: 0, cpuPriority: 'lowest' },
    });
  });
});

describe('per-stream resource options', () => {
  it('accept threads (0 = automatic) and a priority', () => {
    const parsed = parseStreamStartOptions({ encodeThreads: 0, convertThreads: '3', cpuPriority: 'low' });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.options, { encodeThreads: 0, convertThreads: 3, cpuPriority: 'low' });
  });

  it('leave an empty field out so the settings apply, and refuse bad values', () => {
    assert.deepEqual(parseStreamStartOptions({ encodeThreads: '', convertThreads: null, cpuPriority: '' }), { ok: true, options: {} });
    for (const body of [{ encodeThreads: 65 }, { convertThreads: -1 }, { encodeThreads: 'x' }, { cpuPriority: 'high' }]) {
      assert.equal(parseStreamStartOptions(body).ok, false, JSON.stringify(body));
    }
  });
});
