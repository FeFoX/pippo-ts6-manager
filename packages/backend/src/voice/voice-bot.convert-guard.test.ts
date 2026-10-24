import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONVERT_MIN_DEADLINE_MS,
  CONVERT_MAX_DEADLINE_MS,
  CONVERT_STALL_MS,
  convertDeadlineMs,
  convertGiveUpReason,
} from './streaming/convert-limits.js';
import { parseDirectCheck } from './streaming/source-probe.js';

// The music folder is read when the module loads, so point it at a temporary folder first.
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-convert-guard-'));
process.env.MUSIC_DIR = musicDir;
const { VoiceBot } = await import('./voice-bot.js');

function makeBot(): InstanceType<typeof VoiceBot> {
  return new VoiceBot({
    seekCooldownSec: 0,
    id: 11,
    serverConfigId: 1,
    name: 'test',
    serverHost: '127.0.0.1',
    serverPort: 9987,
    nickname: 'Bot',
    volume: 50,
  });
}

const QUALITY = {
  requested: '720p', actual: '720p', width: 1280, height: 720,
  sourceWidth: null, sourceHeight: null, note: null,
};
const REMOTE = 'https://cdn.example/episode.mp4';
const BFRAMES_JSON = JSON.stringify({
  streams: [{ codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', has_b_frames: 2, bit_rate: '640000' }],
  packets: [{ pts: 2048, dts: 0 }, { pts: 6144, dts: 1024 }, { pts: 4096, dts: 2048 }],
  format: { duration: '120', bit_rate: '700000' },
});

describe('convert limits', () => {
  it('gives a short video the minimum and a long one at most the sidecar limit', () => {
    assert.equal(convertDeadlineMs(60), CONVERT_MIN_DEADLINE_MS);
    assert.equal(convertDeadlineMs(900), 30 * 60_000); // half real time
    assert.equal(convertDeadlineMs(86_400), CONVERT_MAX_DEADLINE_MS);
  });

  it('gives up on a stalled, overdue or hopelessly slow conversion and on nothing else', () => {
    const ok = { elapsedMs: 60_000, stalledMs: 5_000, etaSec: 100 };
    assert.equal(convertGiveUpReason(ok, 120), null);
    assert.match(convertGiveUpReason({ ...ok, stalledMs: CONVERT_STALL_MS }, 120) ?? '', /no progress/);
    assert.match(convertGiveUpReason({ ...ok, elapsedMs: CONVERT_MIN_DEADLINE_MS }, 120) ?? '', /took longer/);
    assert.match(convertGiveUpReason({ ...ok, etaSec: 3 * 3600 }, 120) ?? '', /too slow/);
    // The first seconds report a wild speed; they are not held against the conversion.
    assert.equal(convertGiveUpReason({ elapsedMs: 5_000, stalledMs: 5_000, etaSec: 3 * 3600 }, 120), null);
  });
});

describe('the direct check reports the source bitrate', () => {
  it('prefers the stream figure, falls back to the container, and is silent when neither is known', () => {
    assert.equal(parseDirectCheck(BFRAMES_JSON).bitrateKbps, 640);
    const noStream = JSON.stringify({
      streams: [{ codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', has_b_frames: 0, bit_rate: 'N/A' }],
      format: { duration: '120', bit_rate: '2500000' },
    });
    assert.equal(parseDirectCheck(noStream).bitrateKbps, 2500);
    const none = JSON.stringify({
      streams: [{ codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', has_b_frames: 0 }],
      format: { duration: '120' },
    });
    assert.equal('bitrateKbps' in parseDirectCheck(none), false);
  });
});

/** A bot about to start a direct stream, with a sidecar whose converter is scripted. */
function prepBot(statuses: Array<Record<string, unknown>>) {
  const b = makeBot() as any;
  b._videoDirectRequested = true;
  b._videoSettings = { ...b._videoSettings, directFallback: 'ultrafast', encodeThreads: 3 };
  b._videoLocalHosts = [];
  const calls = { started: [] as any[], cancelled: [] as string[], polls: 0 };
  b.sidecarHttp = {
    probe: async () => BFRAMES_JSON,
    convertStart: async (o: any) => { calls.started.push(o); return { id: 'job1', state: 'running', percent: 0, speed: 0 }; },
    convertStatus: async () => ({ id: 'job1', ...statuses[Math.min(calls.polls++, statuses.length - 1)] }),
    convertCancel: async (id: string) => { calls.cancelled.push(id); },
  };
  return { b, calls };
}

async function drive<T>(work: Promise<T>, tickMs: number, ticks: number): Promise<T> {
  let done = false;
  const guard = work.finally(() => { done = true; });
  for (let i = 0; i < ticks && !done; i++) {
    await new Promise<void>((r) => setImmediate(r));
    mock.timers.tick(tickMs);
  }
  return guard;
}

describe('a conversion that does not finish', () => {
  beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }); });
  afterEach(() => { mock.timers.reset(); });

  it('passes the source bitrate and the thread setting to the converter', async () => {
    const { b, calls } = prepBot([{ state: 'done', percent: 100, speed: 12 }]);
    const origWrite = b.sidecarHttp.convertStatus;
    b.sidecarHttp.convertStatus = async () => {
      fs.writeFileSync(path.join(musicDir, calls.started[0].output), 'converted');
      return origWrite();
    };
    await drive(b.prepareDirectSource({ path: REMOTE, loop: true, durationSec: null }, QUALITY, 'vod'), 2_000, 20);
    assert.equal(calls.started[0].sourceBitrateKbps, 640);
    assert.equal(calls.started[0].threads, 3);
    assert.equal(calls.started[0].convertThreads, undefined, 'automatic is left to the sidecar');
    assert.equal(calls.started[0].cpuPriority, 'normal');
  });

  it('uses the stream\'s own thread and priority choices over the settings', async () => {
    const { b, calls } = prepBot([{ state: 'done', percent: 100, speed: 12 }]);
    b._videoSettings = { ...b._videoSettings, encodeThreads: 3, convertThreads: 5, cpuPriority: 'low' };
    const origWrite = b.sidecarHttp.convertStatus;
    b.sidecarHttp.convertStatus = async () => {
      fs.writeFileSync(path.join(musicDir, calls.started[0].output), 'converted');
      return origWrite();
    };
    // Settings only: the bot, server or global values apply.
    await drive(b.prepareDirectSource({ path: REMOTE, loop: true, durationSec: null }, QUALITY, 'vod'), 2_000, 20);
    assert.deepEqual(
      [calls.started[0].threads, calls.started[0].convertThreads, calls.started[0].cpuPriority],
      [3, 5, 'low'],
    );
    // This stream asked for its own: 0 means automatic, so nothing is sent for the threads.
    calls.started.length = 0;
    calls.polls = 0;
    b._videoRequestedEncodeThreads = 0;
    b._videoRequestedConvertThreads = 2;
    b._videoRequestedCpuPriority = 'lowest';
    await drive(b.prepareDirectSource({ path: REMOTE, loop: true, durationSec: null }, QUALITY, 'vod'), 2_000, 20);
    assert.deepEqual(
      [calls.started[0].threads, calls.started[0].convertThreads, calls.started[0].cpuPriority],
      [undefined, 2, 'lowest'],
    );
  });

  it('is abandoned once its progress stops moving, and the stream is re-encoded instead', async () => {
    const { b, calls } = prepBot([{ state: 'running', percent: 40, speed: 1 }]);
    const notices: string[] = [];
    b._videoNotice = (m: string) => notices.push(m);
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    const out = await drive(b.prepareDirectSource(resolved, QUALITY, 'vod'), 30_000, 40);
    assert.equal(out, resolved, 'the original source is handed back');
    assert.deepEqual(calls.cancelled, ['job1'], 'the sidecar is told to stop converting');
    assert.match(b._videoPrepNote ?? '', /no progress/);
    assert.equal(b.videoPreparation, null);
  });
});

describe('a seek that waits for the video address', () => {
  beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }); });
  afterEach(() => { mock.timers.reset(); });

  it('fails after 30 s and does not hold up the next pause', async () => {
    const bot = makeBot();
    const b = bot as any;
    b._videoStreaming = true;
    b._videoSource = 'https://www.youtube.com/watch?v=abc';
    b._videoTempFile = null;
    b._videoDurationSec = 600;
    b._videoSourceMode = 'vod';
    b._videoLoop = false;
    b._videoQuality = QUALITY;
    b._videoEncoder = { selected: 'h264', active: 'h264', codec: 'h264', hardware: false, fallbackReason: null };
    b._videoOffsetSec = 0;
    b._videoOffsetAt = Date.now();
    const calls: string[] = [];
    b.sidecarHttp = {
      setSource: async () => { calls.push('source'); return null; },
      stopSource: async () => { calls.push('stop'); },
    };
    let lateTemp: string | null = null;
    b.resolveStreamSource = (_s: string, _h: number, isAbandoned: () => boolean) =>
      new Promise((resolve, reject) => {
        // yt-dlp answers long after the seek gave up.
        setTimeout(() => {
          if (isAbandoned()) { lateTemp = 'dropped'; reject(new Error('late')); } else resolve({ path: 'x', loop: false, durationSec: 600 });
        }, 120_000);
      });
    b.claimRemoteSeek = async () => {};

    const seek = bot.seekVideo(30);
    const settled = seek.then(() => 'ok', (err: Error) => err.message);
    const pause = bot.pauseVideo();
    await drive(Promise.race([settled, pause]), 10_000, 10);
    assert.match(String(await settled), /took longer than 30 s/);
    await drive(pause, 10_000, 10);
    assert.deepEqual(calls, ['stop'], 'the pause ran right after the failed seek');
    mock.timers.tick(120_000);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(lateTemp, 'dropped', 'the late answer was told it had been abandoned');
  });
});
