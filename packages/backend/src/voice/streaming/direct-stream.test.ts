import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDirectEligible, directProbeArgs, parseDirectCheck } from './source-probe.js';
import { youtubeVideoFormatArgs, YOUTUBE_VIDEO_FORMAT_SORT } from './video-download.js';
import { parseStreamStartOptions } from './start-options.js';

const stream = { codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', has_b_frames: 0 };
const noReorder = Array.from({ length: 30 }, (_, i) => ({ pts: 1024 * i + 2048, dts: 1024 * i }));
const reorder = [
  { pts: 2048, dts: 0 }, { pts: 6144, dts: 1024 }, { pts: 4096, dts: 2048 }, { pts: 3072, dts: 3072 },
];

describe('direct stream check', () => {
  it('accepts H.264 4:2:0 without reordering, even when the timestamps start at an offset', () => {
    const r = parseDirectCheck(JSON.stringify({ streams: [stream], packets: noReorder }));
    assert.deepEqual(r, { ok: true, reason: null, codec: 'h264' });
  });

  it('accepts VP9 profile 0 whatever its hidden frames do, because its packets are in display order', () => {
    const vp9 = { codec_name: 'vp9', profile: 'Profile 0', pix_fmt: 'yuv420p', has_b_frames: 1 };
    const r = parseDirectCheck(JSON.stringify({ streams: [vp9], packets: reorder }));
    assert.deepEqual(r, { ok: true, reason: null, codec: 'vp9' });
  });

  it('refuses VP9 that viewers are not offered: other profiles and 10-bit', () => {
    for (const change of [{ profile: 'Profile 2', pix_fmt: 'yuv420p10le' }, { profile: 'Profile 1', pix_fmt: 'yuv444p' }, { profile: 'Profile 1' }]) {
      const r = parseDirectCheck(JSON.stringify({ streams: [{ codec_name: 'vp9', pix_fmt: 'yuv420p', ...change }], packets: noReorder }));
      assert.equal(r.ok, false, JSON.stringify(change));
      assert.equal(r.codec, null);
    }
  });

  it('refuses a stream whose frames come out of display order', () => {
    const r = parseDirectCheck(JSON.stringify({ streams: [stream], packets: reorder }));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /B-frames/);
  });

  it('refuses B-frames reported by the header', () => {
    const r = parseDirectCheck(JSON.stringify({ streams: [{ ...stream, has_b_frames: 2 }], packets: noReorder }));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /B-frames/);
  });

  it('refuses other codecs, 10-bit and professional profiles', () => {
    for (const [change, text] of [
      [{ codec_name: 'av1' }, /AV1/],
      [{ codec_name: 'hevc', profile: 'Main' }, /HEVC/],
      [{ pix_fmt: 'yuv420p10le' }, /yuv420p10le/],
      [{ profile: 'High 4:2:2' }, /profile/],
    ] as const) {
      const r = parseDirectCheck(JSON.stringify({ streams: [{ ...stream, ...change }], packets: noReorder }));
      assert.equal(r.ok, false, JSON.stringify(change));
      assert.match(r.reason ?? '', text);
    }
  });

  it('treats a failed or empty probe as "cannot copy", never as "can"', () => {
    assert.equal(parseDirectCheck(null).ok, false);
    assert.equal(parseDirectCheck('not json').ok, false);
    assert.equal(parseDirectCheck(JSON.stringify({ streams: [] })).ok, false);
  });

  it('probes a bounded number of packets of the first video stream', async () => {
    const args = directProbeArgs('/data/music/a.mp4');
    assert.ok(args.includes('-select_streams') && args.includes('v:0'));
    assert.ok(args.some((a) => /^%\+#\d+$/.test(a)), 'reads a limited number of packets');
    assert.equal(args.at(-1), '/data/music/a.mp4');
    const seen: string[][] = [];
    const r = await checkDirectEligible('/data/music/a.mp4', async (a) => {
      seen.push(a);
      return JSON.stringify({ streams: [stream], packets: noReorder });
    });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
    assert.equal((await checkDirectEligible('-evil')).ok, false);
  });
});

describe('YouTube formats for a direct stream', () => {
  it('keeps the usual choice by default', () => {
    const args = youtubeVideoFormatArgs(720);
    assert.equal(args[3], YOUTUBE_VIDEO_FORMAT_SORT);
    assert.ok(!args[1].includes('avc1') && !args[1].includes('vp09'));
  });

  it('asks for VP9 first, then H.264, and keeps the usual choice as a fallback', () => {
    const args = youtubeVideoFormatArgs(720, true);
    assert.ok(args[1].startsWith('bv*[vcodec^=vp09][height<=720]'));
    assert.ok(args[1].indexOf('vcodec^=vp09') < args[1].indexOf('vcodec^=avc1'), 'VP9 before H.264');
    assert.ok(args[1].includes('/bv*[height<=720][dynamic_range=SDR]+ba'), 'the fallback is still there');
  });

  it('prefers a plain file to an HLS playlist within a codec, but keeps HLS as an option', () => {
    const choices = youtubeVideoFormatArgs(720, true)[1].split('/');
    const vp9Plain = choices.findIndex((c) => c.includes('vcodec^=vp09') && c.includes('[protocol!*=m3u8]'));
    const vp9Any = choices.findIndex((c) => c.includes('vcodec^=vp09') && !c.includes('protocol'));
    const avc1Plain = choices.findIndex((c) => c.includes('vcodec^=avc1') && c.includes('[protocol!*=m3u8]'));
    assert.ok(vp9Plain === 0 && vp9Any === 1, 'the plain VP9 file, then any VP9');
    assert.ok(avc1Plain > vp9Any, 'H.264 still comes after VP9');
  });

  it('for a seek, asks for formats without HLS first and falls back to the usual choice', () => {
    for (const direct of [true, false]) {
      const choices = youtubeVideoFormatArgs(720, direct, true)[1].split('/');
      const firstAny = choices.findIndex((c) => !c.includes('[protocol!*=m3u8]'));
      assert.ok(firstAny > 0, 'something without HLS is tried first');
      assert.ok(choices.slice(0, firstAny).every((c) => c.includes('+ba[protocol!*=m3u8]') || c.endsWith('[protocol!*=m3u8]')));
      assert.deepEqual(choices.slice(-2), ['bv*+ba', 'b'], 'the last resort is unchanged');
    }
    assert.ok(youtubeVideoFormatArgs(720, true, true)[1].startsWith('bv*[vcodec^=vp09][height<=720]'));
  });
});

describe('direct in the start request', () => {
  it('accepts true and false, and rejects anything else', () => {
    assert.deepEqual(parseStreamStartOptions({ direct: true }), { ok: true, options: { direct: true } });
    assert.deepEqual(parseStreamStartOptions({ direct: false }), { ok: true, options: { direct: false } });
    assert.deepEqual(parseStreamStartOptions({}), { ok: true, options: {} });
    const bad = parseStreamStartOptions({ direct: 'yes' });
    assert.equal(bad.ok, false);
  });
});
