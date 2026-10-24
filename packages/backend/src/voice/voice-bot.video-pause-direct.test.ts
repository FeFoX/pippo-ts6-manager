import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The music folder is read when the module loads, so point it at a temporary folder first.
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-pause-test-'));
process.env.MUSIC_DIR = musicDir;
const { VoiceBot } = await import('./voice-bot.js');

function makeBot(): InstanceType<typeof VoiceBot> {
  return new VoiceBot({
    seekCooldownSec: 0,
    id: 9,
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

/** A finite video that is playing from a downloaded file, with a sidecar that records its calls. */
function fakeVideo(bot: InstanceType<typeof VoiceBot>, opts: { mode?: string; loop?: boolean; direct?: boolean } = {}) {
  const b = bot as any;
  const calls: Array<{ kind: 'source' | 'stop'; source?: string; options?: any }> = [];
  const file = path.join(musicDir, '.stream-1.mp4');
  fs.writeFileSync(file, 'x');
  b._videoStreaming = true;
  b._videoSource = 'https://www.youtube.com/watch?v=abc';
  b._videoTempFile = file;
  b._videoDurationSec = 600;
  b._videoSourceMode = opts.mode ?? 'vod';
  b._videoLoop = opts.loop ?? false;
  b._videoQuality = QUALITY;
  b._videoDirectRequested = opts.direct ?? false;
  b._videoEncoder = { selected: 'h264', active: 'h264', codec: 'h264', hardware: false, fallbackReason: null };
  b._videoOffsetSec = 0;
  b._videoOffsetAt = Date.now();
  b.sidecarHttp = {
    setSource: async (source: string, options: any) => { calls.push({ kind: 'source', source, options }); return null; },
    stopSource: async () => { calls.push({ kind: 'stop' }); },
  };
  return { b, calls, file };
}

describe('video pause', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('pauses by stopping the encode and freezes the position', async () => {
    const bot = makeBot();
    const { calls } = fakeVideo(bot);
    mock.timers.tick(40_000);
    assert.equal(bot.canPauseVideo, true);
    await bot.pauseVideo();
    assert.deepEqual(calls.map((c) => c.kind), ['stop']);
    assert.equal(bot.videoPaused, true);
    assert.equal(bot.videoStreamStatus.paused, true);
    mock.timers.tick(90_000);
    assert.equal(bot.videoPositionSec, 40, 'the clock stops while paused');
  });

  it('resumes from the paused position', async () => {
    const bot = makeBot();
    const { calls } = fakeVideo(bot);
    mock.timers.tick(40_000);
    await bot.pauseVideo();
    mock.timers.tick(90_000);
    await bot.resumeVideo();
    const last = calls.at(-1)!;
    assert.equal(last.kind, 'source');
    assert.equal(last.options.startSeconds, 40);
    assert.equal(bot.videoPaused, false);
    assert.equal(bot.videoStreamStatus.paused, false);
    mock.timers.tick(10_000);
    assert.equal(bot.videoPositionSec, 50, 'it counts again from where it stopped');
  });

  it('pausing twice is harmless and resuming a playing video does nothing', async () => {
    const bot = makeBot();
    const { calls } = fakeVideo(bot);
    await bot.resumeVideo();
    assert.equal(calls.length, 0);
    await bot.pauseVideo();
    await bot.pauseVideo();
    assert.deepEqual(calls.map((c) => c.kind), ['stop']);
  });

  it('refuses to pause a live stream or a looping video', async () => {
    const live = makeBot();
    fakeVideo(live, { mode: 'live' });
    assert.equal(live.canPauseVideo, false);
    await assert.rejects(() => live.pauseVideo(), /cannot be paused/);

    const loop = makeBot();
    fakeVideo(loop, { loop: true });
    assert.equal(loop.canPauseVideo, false);
  });

  it('a volume change while paused does not start the video again', async () => {
    const bot = makeBot();
    const { calls } = fakeVideo(bot);
    await bot.pauseVideo();
    await bot.applyVolume(30);
    assert.deepEqual(calls.map((c) => c.kind), ['stop'], 'no /source while paused');
    await bot.resumeVideo();
    assert.equal(calls.at(-1)!.options.volume, 30, 'the new level is used when it plays again');
  });

  it('a seek while paused plays from the target', async () => {
    const bot = makeBot();
    const { calls } = fakeVideo(bot);
    await bot.pauseVideo();
    await bot.seekVideo(120);
    assert.equal(calls.at(-1)!.options.startSeconds, 120);
    assert.equal(bot.videoPaused, false);
  });

  it('a failed stop leaves the video playing', async () => {
    const bot = makeBot();
    const { b } = fakeVideo(bot);
    b.sidecarHttp.stopSource = async () => { throw new Error('sidecar down'); };
    await assert.rejects(() => bot.pauseVideo(), /sidecar down/);
    assert.equal(bot.videoPaused, false);
    assert.equal(bot.canPauseVideo, true);
  });
});

describe('direct stream decision', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('re-encodes and says nothing when direct was not requested', async () => {
    const bot = makeBot();
    const { calls, file } = fakeVideo(bot);
    await bot.seekVideo(5);
    const options = calls.at(-1)!.options;
    assert.equal(options.passthrough, undefined);
    assert.equal(options.source, undefined);
    assert.equal(bot.videoStreamStatus.direct, false);
    assert.equal(bot.videoStreamStatus.directFallback, null);
    assert.ok(file);
  });

  it('falls back to re-encoding, with the reason, when the file cannot be copied', async () => {
    const bot = makeBot();
    const { calls } = fakeVideo(bot, { direct: true });
    // The file is not a video, so the check fails; the stream must still play.
    await bot.seekVideo(5);
    assert.equal(calls.at(-1)!.options.passthrough, undefined);
    const status = bot.videoStreamStatus;
    assert.equal(status.direct, false);
    assert.match(status.directFallback ?? '', /Direct stream not possible: .* The video is re-encoded\./);
  });

  it('a remote source that cannot be inspected is re-encoded', async () => {
    const bot = makeBot();
    const { b, calls } = fakeVideo(bot, { direct: true });
    b._videoTempFile = null;
    b.sidecarHttp.probe = async () => { throw new Error('probe failed'); };
    b.resolveStreamSource = async () => ({ path: 'https://cdn.example/video.mp4', loop: false });
    b.probeStreamSource = async () => null;
    await bot.seekVideo(5);
    assert.equal(calls.filter((c) => c.kind === 'source').at(-1)!.options.passthrough, undefined);
    assert.match(bot.videoStreamStatus.directFallback ?? '', /could not be inspected/);
  });

  it('a remote video the sidecar finds copyable is copied from where it is', async () => {
    const bot = makeBot();
    const { b, calls } = fakeVideo(bot, { direct: true });
    b._videoTempFile = null;
    b.sidecarHttp.probe = async () => JSON.stringify({
      streams: [{ codec_name: 'vp9', profile: 'Profile 0', pix_fmt: 'yuv420p' }], packets: [], format: { duration: '90' },
    });
    b.resolveStreamSource = async () => ({ path: 'https://cdn.example/video.webm', loop: false });
    b.probeStreamSource = async () => null;
    await bot.seekVideo(5);
    const last = calls.filter((c) => c.kind === 'source').at(-1)!;
    assert.equal(last.options.passthrough, true);
    assert.equal(last.options.encoder, 'vp9');
  });

  it('copies when the file passes the check, and keeps the answer across seeks', async () => {
    const { bot, calls, probes } = remoteBot('vp9');
    await bot.seekVideo(5);
    await bot.seekVideo(9);
    const sources = calls.filter((c) => c.kind === 'source');
    assert.equal(sources.at(-1)!.options.passthrough, true);
    assert.equal(sources.at(-1)!.options.encoder, 'vp9', 'the sidecar is told which codec the file is');
    assert.equal(probes.count, 1, 'the second seek answers from the cache and does not probe again');
    assert.equal(bot.videoStreamStatus.direct, true);
  });

  it('keeps the codec the viewers negotiated: a re-encode follows it', async () => {
    const bot = makeBot();
    const { b, calls } = fakeVideo(bot, { direct: true });
    b._videoEncoder.selected = 'vp8';
    b._videoActiveCodec = 'vp9';
    // Direct was asked for but the file cannot be copied: it is re-encoded as VP9, not as the VP8 default.
    await bot.seekVideo(5);
    assert.equal(calls.at(-1)!.options.encoder, 'vp9');
    assert.equal(calls.at(-1)!.options.passthrough, undefined);
  });

  it('keeps the codec the viewers negotiated: another codec is not copied', async () => {
    // A copyable H.264 file cannot be copied to viewers who negotiated VP9.
    const { b, bot, calls } = remoteBot('h264');
    b._videoActiveCodec = 'vp9';
    await bot.seekVideo(5);
    const last = calls.filter((c) => c.kind === 'source').at(-1)!;
    assert.equal(last.options.passthrough, undefined);
    assert.equal(last.options.encoder, 'vp9', 'the re-encode follows the negotiated codec');
    assert.equal(bot.videoStreamStatus.direct, false);
    assert.match(bot.videoStreamStatus.directFallback ?? '', /viewers are already receiving VP9 and this video is H264/);
  });

  it('a codec is copied when it matches the one the viewers negotiated', async () => {
    const { b, bot, calls } = remoteBot('vp9');
    b._videoActiveCodec = 'vp9';
    await bot.seekVideo(5);
    const last = calls.filter((c) => c.kind === 'source').at(-1)!;
    assert.equal(last.options.passthrough, true);
    assert.equal(last.options.encoder, 'vp9');
  });

  it('the real decision is cached per file', async () => {
    const bot = makeBot();
    const { b } = fakeVideo(bot, { direct: true });
    const file = b._videoTempFile as string;
    const first = await b.decideDirect(file);
    assert.equal(first, null);
    // Remove the file: a second call must answer from the cache, not probe again.
    fs.unlinkSync(file);
    const second = await b.decideDirect(file);
    assert.equal(second, null);
    assert.equal(b._videoDirectPath, file);
  });

  it('a cached "copy this" answer is not reused once viewers have negotiated another codec', async () => {
    const { b, probes } = remoteBot('vp9');
    // No viewer has negotiated anything yet, so the file is copied and the answer is cached.
    assert.equal(await b.decideDirect(REMOTE_WEBM), 'vp9');
    assert.equal(b._videoDirect, true);
    assert.equal(await b.decideDirect(REMOTE_WEBM), 'vp9', 'while nothing changed, the cache answers');
    assert.equal(probes.count, 1);
    // A viewer then joins on H.264. The next decision for the same file must not copy VP9 to them.
    b._videoActiveCodec = 'h264';
    assert.equal(await b.decideDirect(REMOTE_WEBM), null);
    assert.equal(b._videoDirect, false);
    assert.match(b._videoDirectFallback ?? '', /viewers are already receiving H264 and this video is VP9/);
  });

  it('a seek after a viewer joined on another codec re-encodes instead of copying the cached answer', async () => {
    const { b, bot, calls } = remoteBot('vp9');
    await bot.seekVideo(5);
    assert.equal(calls.filter((c) => c.kind === 'source').at(-1)!.options.passthrough, true);
    // The first seek copied VP9 and cached it. Now the stream's codec is H.264.
    b._videoActiveCodec = 'h264';
    await bot.seekVideo(9);
    const last = calls.filter((c) => c.kind === 'source').at(-1)!;
    assert.equal(last.options.passthrough, undefined, 'VP9 is not copied to viewers who negotiated H.264');
    assert.equal(last.options.encoder, 'h264', 'the re-encode follows the negotiated codec');
    assert.equal(bot.videoStreamStatus.direct, false);
  });

  it('a volume change after a viewer joined on another codec does not copy the cached answer either', async () => {
    const { b, bot, calls } = remoteBot('vp9');
    await bot.seekVideo(5);
    b._videoActiveCodec = 'h264';
    await bot.applyVolume(30);
    const last = calls.filter((c) => c.kind === 'source').at(-1)!;
    assert.equal(last.options.volume, 30);
    assert.equal(last.options.passthrough, undefined);
    assert.equal(last.options.encoder, 'h264');
  });

  it('a different file is judged on its own, not by the previous answer', async () => {
    const { b, probes } = remoteBot('vp9');
    b._videoActiveCodec = 'h264';
    assert.equal(await b.decideDirect(REMOTE_WEBM), null);
    // A different file is judged on its own, not by the previous answer.
    assert.equal(await b.decideDirect('https://cdn.example/other.webm'), null);
    assert.equal(probes.count, 2);
  });
});

const REMOTE_WEBM = 'https://cdn.example/video.webm';

const COPYABLE: Record<'vp9' | 'h264', string> = {
  vp9: JSON.stringify({
    streams: [{ codec_name: 'vp9', profile: 'Profile 0', pix_fmt: 'yuv420p' }], packets: [], format: { duration: '90' },
  }),
  h264: JSON.stringify({
    streams: [{ codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', has_b_frames: 0 }], packets: [], format: { duration: '90' },
  }),
};

/**
 * A bot streaming a remote video whose sidecar probe reports a file that can be copied in `codec`.
 * The decision itself is the real one; only the probe answer is scripted, and `probes.count` says
 * how often it was asked.
 */
function remoteBot(codec: 'vp9' | 'h264') {
  const bot = makeBot();
  const { b, calls } = fakeVideo(bot, { direct: true });
  const probes = { count: 0 };
  b._videoTempFile = null;
  b.sidecarHttp.probe = async () => { probes.count++; return COPYABLE[codec]; };
  b.resolveStreamSource = async () => ({ path: REMOTE_WEBM, loop: false });
  b.probeStreamSource = async () => null;
  return { bot, b, calls, probes };
}

// ─── converting a picture that cannot be copied, before a direct stream starts ───────────────

const REMOTE = 'https://cdn.example/episode.mp4';
const BFRAMES_JSON = JSON.stringify({
  streams: [{ codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', has_b_frames: 2 }],
  packets: [{ pts: 2048, dts: 0 }, { pts: 6144, dts: 1024 }, { pts: 4096, dts: 2048 }],
  format: { duration: '120' },
});

/** A bot about to start a direct stream, with a sidecar whose converter is scripted. */
function prepBot(opts: { fallback?: string; probe?: string | (() => Promise<string>); statuses?: any[]; startError?: Error } = {}) {
  const bot = makeBot();
  const b = bot as any;
  b._videoDirectRequested = true;
  b._videoSettings = { ...b._videoSettings, directFallback: opts.fallback ?? 'ultrafast' };
  b._videoLocalHosts = [];
  const notices: string[] = [];
  b._videoNotice = (m: string) => notices.push(m);
  const calls: { started: any[]; cancelled: string[]; polls: number; probes: number } = { started: [], cancelled: [], polls: 0, probes: 0 };
  const statuses = opts.statuses ?? [{ state: 'running', percent: 40, speed: 12 }, { state: 'done', percent: 100, speed: 12 }];
  b.sidecarHttp = {
    probe: async () => {
      calls.probes++;
      return typeof opts.probe === 'function' ? opts.probe() : (opts.probe ?? BFRAMES_JSON);
    },
    convertStart: async (o: any) => {
      if (opts.startError) throw opts.startError;
      calls.started.push(o);
      return { id: 'job1', state: 'running', percent: 0, speed: 0 };
    },
    convertStatus: async () => {
      const st = statuses[Math.min(calls.polls++, statuses.length - 1)];
      if (st.state === 'done') fs.writeFileSync(path.join(musicDir, calls.started[0].output), 'converted');
      if (st instanceof Error) throw st;
      return { id: 'job1', ...st };
    },
    convertCancel: async (id: string) => { calls.cancelled.push(id); },
  };
  return { bot, b, calls, notices };
}

/** Let the conversion's polling timer fire as many times as it needs. */
async function drive<T>(work: Promise<T>, ticks = 20): Promise<T> {
  let done = false;
  const guard = work.finally(() => { done = true; });
  for (let i = 0; i < ticks && !done; i++) {
    await new Promise<void>((r) => setImmediate(r));
    mock.timers.tick(2_000);
  }
  return guard;
}

describe('converting before a direct stream', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('converts a picture it cannot copy, then hands back the converted file', async () => {
    const { b, calls, notices } = prepBot();
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    const out = await drive(b.prepareDirectSource(resolved, QUALITY, 'vod'));
    assert.equal(calls.started.length, 1);
    const job = calls.started[0];
    assert.equal(job.source, REMOTE);
    assert.match(job.output, /^\.stream-\d+\.mp4$/);
    assert.equal(job.preset, 'ultrafast');
    assert.equal(job.width, 1280);
    assert.equal(job.height, 720);
    assert.equal(job.durationSec, 120);
    assert.ok(job.gop >= 10 && job.gop <= 60);
    assert.match(out.path, /\.stream-\d+\.mp4$/);
    assert.equal(out.loop, false);
    assert.equal(out.durationSec, 120);
    assert.equal(b._videoTempFile, out.path, 'the converted file is the one to seek, pause and copy');
    assert.equal(b._videoDurationSec, 120);
    assert.equal(b._videoPrep, null, 'nothing is left "preparing"');
    assert.match(notices[0], /B-frames.*Converting the video first \(x264 ultrafast/);
    assert.match(notices.at(-1)!, /Conversion finished/);
  });

  it('reports how far the conversion is while it runs', async () => {
    const { bot, b } = prepBot({ statuses: [{ state: 'running', percent: 25, speed: 10 }, { state: 'running', percent: 50, speed: 10 }, { state: 'done', percent: 100, speed: 10 }] });
    const work = b.prepareDirectSource({ path: REMOTE, loop: true, durationSec: null }, QUALITY, 'vod');
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    mock.timers.tick(2_000);
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    const p = bot.videoPreparation;
    assert.ok(p, 'a preparation is reported');
    assert.equal(p!.stage, 'converting');
    assert.equal(p!.percent, 25);
    assert.equal(p!.speed, 10);
    assert.equal(p!.etaSec, Math.round(0.75 * 120 / 10));
    await drive(work);
    assert.equal(bot.videoPreparation, null);
  });

  it('leaves a picture that can be copied alone', async () => {
    const copyable = JSON.stringify({ streams: [{ codec_name: 'vp9', profile: 'Profile 0', pix_fmt: 'yuv420p' }], packets: [], format: { duration: '120' } });
    const { b, calls } = prepBot({ probe: copyable });
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    assert.equal(await b.prepareDirectSource(resolved, QUALITY, 'vod'), resolved);
    assert.equal(calls.started.length, 0);
  });

  it('does nothing when the setting says to re-encode while playing', async () => {
    const { b, calls } = prepBot({ fallback: 'live' });
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    assert.equal(await b.prepareDirectSource(resolved, QUALITY, 'vod'), resolved);
    assert.equal(calls.probes, 0);
    assert.equal(calls.started.length, 0);
  });

  it('uses the speed the admin chose', async () => {
    const { b, calls } = prepBot({ fallback: 'veryfast' });
    await drive(b.prepareDirectSource({ path: REMOTE, loop: true, durationSec: null }, QUALITY, 'vod'));
    assert.equal(calls.started[0].preset, 'veryfast');
  });

  it('never converts a live source: it has no end', async () => {
    const live = JSON.stringify({ streams: [{ codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', has_b_frames: 2 }], packets: [] });
    const { b, calls } = prepBot({ probe: live });
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    assert.equal(await b.prepareDirectSource(resolved, QUALITY, 'vod'), resolved, 'no length means live');
    const declaredLive = { ...resolved, live: true };
    assert.equal(await b.prepareDirectSource(declaredLive, QUALITY, 'live'), declaredLive);
    assert.equal(calls.started.length, 0);
  });

  it('does not convert a video longer than the limit, and says so', async () => {
    const long = JSON.stringify({ streams: [{ codec_name: 'h264', profile: 'Main', pix_fmt: 'yuv420p', has_b_frames: 2 }], packets: [], format: { duration: '2257' } });
    const { b, calls, notices } = prepBot({ probe: long });
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    assert.equal(await b.prepareDirectSource(resolved, QUALITY, 'vod'), resolved);
    assert.equal(calls.started.length, 0);
    assert.match(b._videoPrepNote, /38 min long.*15 min.*Max video duration/);
    assert.match(notices[0], /Direct stream not possible/);
  });

  it('falls back to re-encoding, with the reason, when the conversion fails', async () => {
    const { b, notices } = prepBot({ statuses: [{ state: 'failed', percent: 3, speed: 5, error: 'Server returned 403 Forbidden' }] });
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    const out = await drive(b.prepareDirectSource(resolved, QUALITY, 'vod'));
    assert.equal(out, resolved);
    assert.match(b._videoPrepNote, /Converting it first failed \(Server returned 403 Forbidden\).*re-encoded while it plays/);
    assert.match(notices.at(-1)!, /Direct stream: Converting it first failed/);
    assert.equal(b._videoPrep, null);
  });

  it('falls back when the converter is busy or cannot start', async () => {
    const { b } = prepBot({ startError: new Error('Sidecar /convert: 409 another conversion is running') });
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    assert.equal(await drive(b.prepareDirectSource(resolved, QUALITY, 'vod')), resolved);
    assert.match(b._videoPrepNote, /another conversion is running/);
  });

  it('gives up when the converter stops answering', async () => {
    const failing = Array.from({ length: 6 }, () => new Error('connection refused'));
    const { b } = prepBot({ statuses: failing });
    const resolved = { path: REMOTE, loop: true, durationSec: null };
    assert.equal(await drive(b.prepareDirectSource(resolved, QUALITY, 'vod'), 40), resolved);
    assert.match(b._videoPrepNote, /lost contact with the converter/);
  });

  it('stops the conversion when the start is cancelled', async () => {
    const { b, calls } = prepBot({ statuses: [{ state: 'running', percent: 10, speed: 8 }] });
    b._videoStarting = true;
    const work = b.prepareDirectSource({ path: REMOTE, loop: true, durationSec: null }, QUALITY, 'vod');
    const settled = work.then(() => 'finished', (e: Error) => e.message);
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    b.abortPendingVideoStart(new Error('Stopped by chat command'));
    assert.deepEqual(calls.cancelled, ['job1'], 'the sidecar is told to stop');
    mock.timers.tick(2_000);
    assert.equal(await settled, 'Stopped by chat command');
  });
});
