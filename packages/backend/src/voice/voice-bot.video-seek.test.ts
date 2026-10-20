import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The music folder is read when the module loads, so point it at a temporary folder first.
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-seek-test-'));
process.env.MUSIC_DIR = musicDir;
const { SeekRateLimitedError, VoiceBot } = await import('./voice-bot.js');

/** `cooldown` is the seek rate limit in seconds; the tests that seek repeatedly turn it off. */
function makeBot(cooldown = 0): InstanceType<typeof VoiceBot> {
  return new VoiceBot({
    seekCooldownSec: cooldown,
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

/** A finite video that is playing, with a sidecar that records what it is asked to do. */
function fakeVideo(bot: VoiceBot, opts: { duration?: number | null; mode?: string; loop?: boolean } = {}) {
  const b = bot as any;
  const sources: Array<{ source: string; options: any }> = [];
  b._videoStreaming = true;
  b._videoSource = 'https://www.youtube.com/watch?v=abc';
  b._videoDurationSec = opts.duration === undefined ? 600 : opts.duration;
  b._videoSourceMode = opts.mode ?? 'vod';
  b._videoLoop = opts.loop ?? false;
  b._videoQuality = QUALITY;
  b._videoEncoder = { selected: 'vp8', active: 'vp8', codec: 'vp8', hardware: false, fallbackReason: null };
  b._videoOffsetSec = 0;
  b._videoOffsetAt = Date.now();
  b.sidecarHttp = {
    setSource: async (source: string, options: any) => { sources.push({ source, options }); return null; },
  };
  // Resolving the source is the YouTube extractor's job; the test only needs a URL back.
  b.resolveStreamSource = async () => ({ path: 'https://rr1.googlevideo.example/video', loop: false });
  b.probeStreamSource = async () => null;
  return { b, sources };
}

describe('video seek', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('counts the position from where the encode started and stops at the end', () => {
    const bot = makeBot();
    fakeVideo(bot, { duration: 100 });
    mock.timers.tick(30_000);
    assert.equal(bot.videoPositionSec, 30);
    assert.deepEqual(bot.playbackProgress, { position: 30, duration: 100 });
    mock.timers.tick(500_000);
    assert.equal(bot.videoPositionSec, 100, 'never past the duration');
  });

  it('can seek a video, known length or not, but not a live one or a looping file', () => {
    const finite = makeBot();
    fakeVideo(finite);
    assert.equal(finite.canSeek, true);

    const live = makeBot();
    fakeVideo(live, { mode: 'live', duration: null });
    assert.equal(live.canSeek, false);

    // A bare remote URL has no reported length; it can still be seeked.
    const unknown = makeBot();
    fakeVideo(unknown, { duration: null });
    assert.equal(unknown.canSeek, true);

    const looping = makeBot();
    fakeVideo(looping, { mode: 'file', loop: true });
    assert.equal(looping.canSeek, false);

    const idle = makeBot();
    assert.equal(idle.canSeek, false);
    assert.equal(idle.videoPositionSec, null);
  });

  it('restarts the encode at the target and moves the position there', async () => {
    const bot = makeBot();
    const { b, sources } = fakeVideo(bot, { duration: 5470 });
    mock.timers.tick(10_000);

    await bot.seek(1800);

    assert.equal(sources.length, 1);
    assert.equal(sources[0].source, 'https://rr1.googlevideo.example/video');
    assert.equal(sources[0].options.startSeconds, 1800);
    assert.equal(sources[0].options.mode, 'vod');
    assert.equal(bot.videoPositionSec, 1800);
    mock.timers.tick(5_000);
    assert.equal(bot.videoPositionSec, 1805);
    // The end-stop clock now covers only what is left of the video.
    assert.ok(b._videoEndTimer, 'end timer re-armed');
    b.clearVideoEndTimer();
  });

  it('clamps the target to the video and keeps clear of the very end', async () => {
    const bot = makeBot();
    const { sources } = fakeVideo(bot, { duration: 100 });
    await bot.seek(-50);
    await bot.seek(9_999);
    assert.equal(sources[0].options.startSeconds, undefined, 'a seek to the start sends no offset');
    assert.equal(sources[1].options.startSeconds, 98);
    (bot as any).clearVideoEndTimer();
  });

  it('runs two quick seeks one after the other', async () => {
    const bot = makeBot();
    const { sources } = fakeVideo(bot);
    const first = bot.seek(60);
    const second = bot.seek(120);
    await Promise.all([first, second]);
    assert.deepEqual(sources.map((s) => s.options.startSeconds), [60, 120]);
    (bot as any).clearVideoEndTimer();
  });

  it('learns the length from a probe when the source reported none, and keeps the target inside it', async () => {
    const bot = makeBot();
    const { b, sources } = fakeVideo(bot, { duration: null });
    b.probeStreamSource = async () => ({ resolution: null, durationSec: 600 });

    await bot.seek(9_999);

    assert.equal(sources[0].options.startSeconds, 598);
    assert.deepEqual(bot.playbackProgress, { position: 598, duration: 600 });
    assert.equal(b._videoEndTimer, null, 'a stream that had no end-stop clock does not get one');
  });

  it('seeks a video of unknown length when the probe finds nothing, without an end-stop clock', async () => {
    const bot = makeBot();
    const { b, sources } = fakeVideo(bot, { duration: null });

    await bot.seek(300);

    assert.equal(sources[0].options.startSeconds, 300);
    assert.equal(bot.videoPositionSec, 300);
    assert.equal(bot.playbackProgress?.duration, 0, 'length unknown');
    assert.equal(b._videoEndTimer, null);
  });

  it('a volume change on a remote video of unknown length keeps the position too', async () => {
    const bot = makeBot();
    const { b, sources } = fakeVideo(bot, { duration: null });
    // The resolver calls a bare URL "loop" by default; the running stream is what counts.
    b.resolveStreamSource = async () => ({ path: 'https://cdn.example/clip.mp4', loop: true });
    mock.timers.tick(120_000);

    await b.pushVideoStreamVolume();

    assert.equal(sources[0].options.startSeconds, 120);
    assert.equal(bot.videoPositionSec, 120);
  });

  it('refuses to seek a live stream', async () => {
    const bot = makeBot();
    fakeVideo(bot, { mode: 'live', duration: null });
    await assert.rejects(() => bot.seek(30), /cannot be seeked/);
  });

  it('a volume change resumes the video where it was instead of from the start', async () => {
    const bot = makeBot();
    const { b, sources } = fakeVideo(bot, { duration: 600 });
    b._videoSettings = { ...b._videoSettings };
    mock.timers.tick(100_000);

    await b.pushVideoStreamVolume();

    assert.equal(sources.length, 1);
    assert.equal(sources[0].options.startSeconds, 100);
    assert.equal(bot.videoPositionSec, 100);
    b.clearVideoEndTimer();
  });
});

describe('seek rate limit on remote sources', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it('lets one seek through, then asks to wait out the two minutes', async () => {
    const bot = makeBot(120);
    const { b, sources } = fakeVideo(bot, { duration: 5470 });

    await bot.seek(1800);
    await assert.rejects(() => bot.seek(2400), (err: unknown) =>
      err instanceof SeekRateLimitedError && err.retryAfterSec === 120 && err.cooldownSec === 120);
    assert.equal(sources.length, 1, 'a refused seek does not restart the encode');

    mock.timers.tick(100_000);
    await assert.rejects(() => bot.seek(2400), (err: unknown) =>
      err instanceof SeekRateLimitedError && err.retryAfterSec === 20);

    mock.timers.tick(20_000);
    await bot.seek(2400);
    assert.deepEqual(sources.map((x) => x.options.startSeconds), [1800, 2400]);
    b.clearVideoEndTimer();
  });

  it('does not limit a video that is already on disk, because that seek never leaves the server', async () => {
    fs.writeFileSync(path.join(musicDir, '.stream-1.mp4'), '');
    const bot = makeBot(120);
    const { b, sources } = fakeVideo(bot, { duration: 600 });
    b._videoTempFile = '.stream-1.mp4';

    await bot.seek(60);
    await bot.seek(120);
    await bot.seek(180);

    assert.deepEqual(sources.map((x) => x.options.startSeconds), [60, 120, 180]);
    assert.match(sources[0].source, /\.stream-1\.mp4$/);
    b.clearVideoEndTimer();
  });

  it('limits a remote audio track the same way and leaves a local file alone', async () => {
    const remote = makeBot(120);
    const r = remote as any;
    const opened: Array<[string, number]> = [];
    const prepare = (b: any, input: string) => {
      b._status = 'playing';
      b._fileStreamActive = true;
      b._nowPlaying = { title: 'x', duration: 600 };
      b.fileInput = input;
      b.startFileStream = async (i: string, t: number) => { opened.push([i, t]); return false; };
    };
    prepare(r, 'https://cdn.example/track.m4a');
    await remote.seek(30);
    prepare(r, 'https://cdn.example/track.m4a');
    await assert.rejects(() => remote.seek(60), SeekRateLimitedError);
    assert.equal(opened.length, 1);

    const local = makeBot(120);
    const l = local as any;
    prepare(l, '/data/music/track.webm');
    await local.seek(30);
    prepare(l, '/data/music/track.webm');
    await local.seek(60);
    assert.deepEqual(opened.slice(1), [['/data/music/track.webm', 30], ['/data/music/track.webm', 60]]);
  });

  it('counts for the whole bot, so a second person is held back too', async () => {
    const bot = makeBot(120);
    const { b } = fakeVideo(bot, { duration: 5470 });
    await bot.seek(100);          // first person
    await assert.rejects(() => bot.seek(900), SeekRateLimitedError); // a different person, same bot
    b.clearVideoEndTimer();
  });

  it('takes the cooldown from the panel setting at the moment of each seek', async () => {
    let seconds = 120;
    const bot = new VoiceBot({
      loadSeekCooldownSec: async () => seconds,
      id: 9, serverConfigId: 1, name: 'test', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50,
    });
    const { b } = fakeVideo(bot, { duration: 5470 });
    await bot.seek(100);
    await assert.rejects(() => bot.seek(200), SeekRateLimitedError);
    seconds = 0; // an admin turns the limit off in the panel: no restart needed
    await bot.seek(300);
    b.clearVideoEndTimer();
  });

  it('falls back to two minutes when the setting cannot be read', async () => {
    const bot = new VoiceBot({
      loadSeekCooldownSec: async () => { throw new Error('database locked'); },
      id: 9, serverConfigId: 1, name: 'test', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50,
    });
    const { b } = fakeVideo(bot, { duration: 5470 });
    await bot.seek(100);
    await assert.rejects(() => bot.seek(200), (err: any) => err instanceof SeekRateLimitedError && err.cooldownSec === 120);
    b.clearVideoEndTimer();
  });
});
