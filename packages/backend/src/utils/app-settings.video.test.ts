import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VIDEO_AUTO_MAX_PRESET_KEY,
  VIDEO_ANNOUNCE_AUTO_STOPS_KEY,
  VIDEO_CPU_USED_KEY,
  VIDEO_DEFAULT_ENCODER_KEY,
  VIDEO_DIRECT_FALLBACK_KEY,
  VIDEO_DIRECT_PACING_KEY,
  VIDEO_ENCODE_PROFILE_KEY,
  VIDEO_ENCODE_THREADS_KEY,
  VIDEO_MAX_BITRATE_KEY,
  VIDEO_NO_VIEWER_TIMEOUT_KEY,
  VIDEO_PREFER_HARDWARE_KEY,
  VIDEO_PRESET_BITRATES_KEY,
  loadServerVideoStreamingSettings,
  loadVideoStreamingSettings,
  mergeVideoSettings,
  parseServerOverrides,
  parseVideoStreamingSettings,
  parseVideoStreamingUpdate,
  videoServerOverridesKey,
  videoStreamingDefaults,
} from './app-settings.js';

const DEFAULT_PRESET_BITRATES = { '480p': 1000, '720p': 4000, '1080p': 7000, '1440p': 8000, '2160p': 9500 };

describe('video streaming settings', () => {
  it('defaults to Balanced profile (1080p, 7000k, cpu-used 4) and 5 min no-viewer stop', () => {
    assert.deepEqual(videoStreamingDefaults({}), {
      noViewerTimeoutSec: 300,
      announceAutoStops: true,
      autoMaxPreset: '1080p',
      defaultEncoder: 'auto',
      preferHardware: false,
      maxBitrateKbps: 7000,
      encodeProfile: 'balanced',
      cpuUsed: 4,
      encodeThreads: 0,
      directPacing: 2.5,
      directFallback: 'ultrafast',
      presetBitrates: DEFAULT_PRESET_BITRATES,
    });
  });

  it('reads env defaults and ignores invalid ones', () => {
    assert.deepEqual(
      videoStreamingDefaults({
        VIDEO_NO_VIEWER_TIMEOUT_SECONDS: '0',
        VIDEO_AUTO_MAX_PRESET: '2160p',
        VIDEO_ENCODER: 'h264_vaapi',
        VIDEO_PREFER_HARDWARE: 'true',
        VIDEO_MAX_BITRATE_KBPS: '12000',
        VIDEO_CPU_USED: '6',
        VIDEO_ENCODE_PROFILE: 'custom',
      }),
      {
        noViewerTimeoutSec: 0,
        announceAutoStops: true,
        autoMaxPreset: '2160p',
        defaultEncoder: 'h264_vaapi',
        preferHardware: true,
        maxBitrateKbps: 12000,
        encodeProfile: 'custom',
        cpuUsed: 6,
        encodeThreads: 0,
        directPacing: 2.5,
        directFallback: 'ultrafast',
        presetBitrates: DEFAULT_PRESET_BITRATES,
      },
    );
    const bad = videoStreamingDefaults({ VIDEO_NO_VIEWER_TIMEOUT_SECONDS: '-1', VIDEO_AUTO_MAX_PRESET: '8k', VIDEO_ENCODER: 'nvenc' });
    assert.equal(bad.noViewerTimeoutSec, 300);
    assert.equal(bad.autoMaxPreset, '1080p');
    assert.equal(bad.defaultEncoder, 'auto');
    assert.equal(bad.encodeProfile, 'balanced');
  });

  it('stored values override env defaults', () => {
    const settings = parseVideoStreamingSettings(
      new Map([
        [VIDEO_NO_VIEWER_TIMEOUT_KEY, '600'],
        [VIDEO_ANNOUNCE_AUTO_STOPS_KEY, 'false'],
        [VIDEO_AUTO_MAX_PRESET_KEY, '1440p'],
        [VIDEO_DEFAULT_ENCODER_KEY, 'vp9'],
        [VIDEO_PREFER_HARDWARE_KEY, 'true'],
        [VIDEO_MAX_BITRATE_KEY, '0'],
        [VIDEO_CPU_USED_KEY, '2'],
        [VIDEO_ENCODE_PROFILE_KEY, 'quality'],
      ]),
      videoStreamingDefaults({ VIDEO_MAX_BITRATE_KBPS: '9000' }),
    );
    assert.deepEqual(settings, {
      noViewerTimeoutSec: 600,
      announceAutoStops: false,
      autoMaxPreset: '1440p',
      defaultEncoder: 'vp9',
      preferHardware: true,
      maxBitrateKbps: 0,
      encodeProfile: 'quality',
      cpuUsed: 2,
      encodeThreads: 0,
      directPacing: 2.5,
      directFallback: 'ultrafast',
      presetBitrates: DEFAULT_PRESET_BITRATES,
    });
  });

  it('accepts AMF in env defaults, stored settings, updates and server overrides', () => {
    assert.equal(videoStreamingDefaults({ VIDEO_ENCODER: 'h264_amf' }).defaultEncoder, 'h264_amf');
    assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_DEFAULT_ENCODER_KEY, 'h264_amf']])).defaultEncoder, 'h264_amf');
    const update = parseVideoStreamingUpdate({ defaultEncoder: 'h264_amf' });
    assert.ok(update.ok);
    assert.equal(update.rows.find((r) => r.key === VIDEO_DEFAULT_ENCODER_KEY)?.value, 'h264_amf');
    assert.equal(parseServerOverrides({ defaultEncoder: 'h264_amf' }).defaultEncoder, 'h264_amf');
  });

  it('marks custom when Advanced knobs diverge from a named profile', () => {
    const settings = parseVideoStreamingSettings(
      new Map([
        [VIDEO_ENCODE_PROFILE_KEY, 'performance'],
        [VIDEO_AUTO_MAX_PRESET_KEY, '720p'],
        [VIDEO_MAX_BITRATE_KEY, '999'],
        [VIDEO_CPU_USED_KEY, '6'],
      ]),
    );
    assert.equal(settings.encodeProfile, 'custom');
  });

  it('expands a named encodeProfile on update', () => {
    const ok = parseVideoStreamingUpdate({ encodeProfile: 'performance' });
    assert.ok(ok.ok);
    assert.deepEqual(
      Object.fromEntries(ok.rows.map((r) => [r.key, r.value])),
      {
        [VIDEO_ENCODE_PROFILE_KEY]: 'performance',
        [VIDEO_AUTO_MAX_PRESET_KEY]: '720p',
        [VIDEO_MAX_BITRATE_KEY]: '4000',
        [VIDEO_CPU_USED_KEY]: '6',
      },
    );
  });

  it('validates updates field by field', () => {
    const ok = parseVideoStreamingUpdate({ noViewerTimeoutSec: 0, announceAutoStops: false, autoMaxPreset: '2160p', preferHardware: false });
    assert.ok(ok.ok);
    const map = Object.fromEntries(ok.rows.map((r) => [r.key, r.value]));
    assert.equal(map[VIDEO_NO_VIEWER_TIMEOUT_KEY], '0');
    assert.equal(map[VIDEO_ANNOUNCE_AUTO_STOPS_KEY], 'false');
    assert.equal(map[VIDEO_AUTO_MAX_PRESET_KEY], '2160p');
    assert.equal(map[VIDEO_PREFER_HARDWARE_KEY], 'false');
    assert.equal(map[VIDEO_ENCODE_PROFILE_KEY], 'custom');
    for (const body of [
      {},
      { noViewerTimeoutSec: 90_000 },
      { announceAutoStops: 'yes' },
      { autoMaxPreset: '4320p' },
      { defaultEncoder: 'nvenc' },
      { preferHardware: 'yes' },
      { maxBitrateKbps: 1.5 },
      { encodeProfile: 'turbo' },
      { cpuUsed: 99 },
    ]) {
      assert.equal(parseVideoStreamingUpdate(body).ok, false, JSON.stringify(body));
    }
  });
});

describe('per-server video defaults', () => {
  function prismaWith(rows: Record<string, string>) {
    return {
      appSetting: {
        findMany: async ({ where }: any) => Object.entries(rows)
          .filter(([key]) => where.key.in.includes(key))
          .map(([key, value]) => ({ key, value })),
      },
    } as any;
  }

  it('drops invalid override fields', () => {
    assert.deepEqual(
      parseServerOverrides('{"autoMaxPreset":"2160p","defaultEncoder":"nvenc","noViewerTimeoutSec":60,"junk":1}'),
      { autoMaxPreset: '2160p', noViewerTimeoutSec: 60, encodeProfile: 'custom' },
    );
    assert.deepEqual(parseServerOverrides('not json'), {});
  });

  it('stores normalized numbers and bools from stringy override input', () => {
    assert.deepEqual(
      parseServerOverrides('{"noViewerTimeoutSec":"60","maxBitrateKbps":"0","preferHardware":true}'),
      { noViewerTimeoutSec: 60, maxBitrateKbps: 0, preferHardware: true, encodeProfile: 'custom' },
    );
  });

  it('parses the per-server announcement switch', () => {
    assert.deepEqual(
      parseServerOverrides('{"announceAutoStops":false}'),
      { announceAutoStops: false },
    );
  });

  it('preserves a named encodeProfile when the override matches that profile', () => {
    assert.deepEqual(
      parseServerOverrides(
        '{"encodeProfile":"performance","autoMaxPreset":"720p","maxBitrateKbps":4000,"cpuUsed":6}',
      ),
      { encodeProfile: 'performance', autoMaxPreset: '720p', maxBitrateKbps: 4000, cpuUsed: 6 },
    );
  });

  it('merges a server\'s overrides over the global defaults', async () => {
    const prisma = prismaWith({
      [VIDEO_NO_VIEWER_TIMEOUT_KEY]: '600',
      [videoServerOverridesKey(2)]: '{"autoMaxPreset":"2160p","preferHardware":true}',
    });
    const s2 = await loadVideoStreamingSettings(prisma, 2);
    assert.equal(s2.noViewerTimeoutSec, 600, 'inherits global');
    assert.equal(s2.autoMaxPreset, '2160p');
    assert.equal(s2.preferHardware, true);
    const s3 = await loadVideoStreamingSettings(prisma, 3);
    assert.equal(s3.autoMaxPreset, videoStreamingDefaults().autoMaxPreset, 'other servers unaffected');

    const detail = await loadServerVideoStreamingSettings(prisma, 2);
    assert.equal(detail.overrides.autoMaxPreset, '2160p');
    assert.equal(detail.overrides.preferHardware, true);
    assert.equal(detail.global.noViewerTimeoutSec, 600);
    assert.equal(detail.effective.autoMaxPreset, '2160p');
  });
});

describe('direct stream pacing setting', () => {
  it('is 2.5 times the bitrate until the admin changes it, and 0 turns it off', () => {
    assert.equal(parseVideoStreamingSettings(new Map()).directPacing, 2.5);
    assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_DIRECT_PACING_KEY, '0']])).directPacing, 0);
    assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_DIRECT_PACING_KEY, '1.5']])).directPacing, 1.5);
  });

  it('ignores stored values that are not a pacing multiple', () => {
    for (const bad of ['0.5', '11', 'fast', '-1', '']) {
      assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_DIRECT_PACING_KEY, bad]])).directPacing, 2.5, bad);
    }
  });

  it('is saved from the settings page and refuses nonsense', () => {
    const ok = parseVideoStreamingUpdate({ directPacing: 4 });
    assert.deepEqual(ok, { ok: true, rows: [{ key: VIDEO_DIRECT_PACING_KEY, value: '4' }] });
    assert.equal(parseVideoStreamingUpdate({ directPacing: 0 }).ok, true);
    for (const bad of [0.5, 11, 'x', null, -2]) {
      assert.equal(parseVideoStreamingUpdate({ directPacing: bad }).ok, false, String(bad));
    }
  });

  it('can be set for one server only', () => {
    assert.deepEqual(parseServerOverrides({ directPacing: 1.5 }), { directPacing: 1.5 });
    assert.deepEqual(parseServerOverrides({ directPacing: 99 }), {});
  });
});

describe('direct stream fallback setting', () => {
  it('converts first with x264 ultrafast until the admin chooses otherwise', () => {
    assert.equal(parseVideoStreamingSettings(new Map()).directFallback, 'ultrafast');
    for (const v of ['live', 'ultrafast', 'superfast', 'veryfast']) {
      assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_DIRECT_FALLBACK_KEY, v]])).directFallback, v);
    }
  });

  it('ignores a stored value that is not one of the choices', () => {
    for (const bad of ['slow', 'placebo', '', 'ULTRAFAST']) {
      assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_DIRECT_FALLBACK_KEY, bad]])).directFallback, 'ultrafast', bad);
    }
  });

  it('is saved from the settings page and refuses anything else', () => {
    assert.deepEqual(parseVideoStreamingUpdate({ directFallback: 'live' }), {
      ok: true, rows: [{ key: VIDEO_DIRECT_FALLBACK_KEY, value: 'live' }],
    });
    for (const bad of ['slow', 1, null, true]) {
      assert.equal(parseVideoStreamingUpdate({ directFallback: bad }).ok, false, String(bad));
    }
  });

  it('can be set for one server only', () => {
    assert.deepEqual(parseServerOverrides({ directFallback: 'superfast' }), { directFallback: 'superfast' });
    assert.deepEqual(parseServerOverrides({ directFallback: 'slow' }), {});
  });
  describe('encode threads', () => {
    it('is automatic (0) until an admin sets it', () => {
      assert.equal(parseVideoStreamingSettings(new Map()).encodeThreads, 0);
    });

    it('reads a stored count and ignores one out of range', () => {
      assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_ENCODE_THREADS_KEY, '3']])).encodeThreads, 3);
      for (const bad of ['65', '-1', 'x', '2.5']) {
        assert.equal(parseVideoStreamingSettings(new Map([[VIDEO_ENCODE_THREADS_KEY, bad]])).encodeThreads, 0, bad);
      }
    });

    it('is saved from the settings page and refuses anything else', () => {
      assert.deepEqual(parseVideoStreamingUpdate({ encodeThreads: 3 }), {
        ok: true, rows: [{ key: VIDEO_ENCODE_THREADS_KEY, value: '3' }],
      });
      assert.deepEqual(parseVideoStreamingUpdate({ encodeThreads: 0 }), {
        ok: true, rows: [{ key: VIDEO_ENCODE_THREADS_KEY, value: '0' }],
      });
      for (const bad of [65, -1, 'many', 2.5]) {
        assert.equal(parseVideoStreamingUpdate({ encodeThreads: bad }).ok, false, String(bad));
      }
    });

    it('can be set for one server only', () => {
      assert.deepEqual(parseServerOverrides({ encodeThreads: 2 }), { encodeThreads: 2 });
      assert.deepEqual(parseServerOverrides({ encodeThreads: 99 }), {});
    });
  });

  describe('bitrate per resolution', () => {
    function prismaWith(rows: Record<string, string>) {
      return {
        appSetting: {
          findMany: async ({ where }: any) => Object.entries(rows)
            .filter(([key]) => where.key.in.includes(key))
            .map(([key, value]) => ({ key, value })),
        },
      } as any;
    }

    it('stored values replace the built-in bitrate of that resolution only', () => {
      const settings = parseVideoStreamingSettings(
        new Map([[VIDEO_PRESET_BITRATES_KEY, '{"720p":3500,"1080p":6000}']]),
      );
      assert.deepEqual(settings.presetBitrates, { ...DEFAULT_PRESET_BITRATES, '720p': 3500, '1080p': 6000 });
    });

    it('ignores stored values that are invalid, unknown or out of range', () => {
      const settings = parseVideoStreamingSettings(
        new Map([[VIDEO_PRESET_BITRATES_KEY, '{"720p":50,"1080p":12000,"1440p":"abc","4k":9000,"480p":1200}']]),
      );
      assert.deepEqual(settings.presetBitrates, { ...DEFAULT_PRESET_BITRATES, '480p': 1200 });
      assert.deepEqual(
        parseVideoStreamingSettings(new Map([[VIDEO_PRESET_BITRATES_KEY, 'not json']])).presetBitrates,
        DEFAULT_PRESET_BITRATES,
      );
    });

    it('accepts a full map on update and stores it as JSON', () => {
      const map = { '480p': 900, '720p': 4000, '1080p': 7000, '1440p': 8500, '2160p': 9500 };
      const ok = parseVideoStreamingUpdate({ presetBitrates: map });
      assert.ok(ok.ok);
      assert.deepEqual(ok.rows, [{ key: VIDEO_PRESET_BITRATES_KEY, value: JSON.stringify(map) }]);
      assert.ok(!ok.rows.some((r) => r.key === VIDEO_ENCODE_PROFILE_KEY), 'does not turn the profile to custom');
    });

    it('rejects a partial map, non-numbers and values outside 100-9500 kbps', () => {
      const full = { ...DEFAULT_PRESET_BITRATES };
      assert.equal(parseVideoStreamingUpdate({ presetBitrates: { '720p': 4000 } }).ok, false);
      assert.equal(parseVideoStreamingUpdate({ presetBitrates: 'nope' }).ok, false);
      assert.equal(parseVideoStreamingUpdate({ presetBitrates: [4000] }).ok, false);
      for (const bad of [99, 9501, 7000.5, -1, 'x', null]) {
        const r = parseVideoStreamingUpdate({ presetBitrates: { ...full, '1080p': bad } });
        assert.equal(r.ok, false, `1080p=${String(bad)}`);
        assert.match((r as { error: string }).error, /1080p/);
      }
      assert.equal(parseVideoStreamingUpdate({ presetBitrates: { ...full, '1080p': 100 } }).ok, true);
      assert.equal(parseVideoStreamingUpdate({ presetBitrates: { ...full, '1080p': 9500 } }).ok, true);
    });

    it('a server override changes only the resolutions it sets', async () => {
      const prisma = prismaWith({
        [VIDEO_PRESET_BITRATES_KEY]: '{"720p":3800}',
        [videoServerOverridesKey(2)]: JSON.stringify({ presetBitrates: { ...DEFAULT_PRESET_BITRATES, '1080p': 6500 } }),
      });
      const s2 = await loadVideoStreamingSettings(prisma, 2);
      assert.equal(s2.presetBitrates['1080p'], 6500);
      assert.equal(s2.presetBitrates['2160p'], 9500);
      const s3 = await loadVideoStreamingSettings(prisma, 3);
      assert.equal(s3.presetBitrates['720p'], 3800, 'other servers use the global map');
      assert.equal(s3.presetBitrates['1080p'], 7000);
    });

    it('merges a partial override map over the global one', () => {
      const global = videoStreamingDefaults({});
      const merged = mergeVideoSettings(global, { presetBitrates: { '720p': 3000 } as typeof global.presetBitrates });
      assert.deepEqual(merged.presetBitrates, { ...DEFAULT_PRESET_BITRATES, '720p': 3000 });
      assert.equal(mergeVideoSettings(global, {}).presetBitrates['1080p'], 7000);
    });
  });
});
