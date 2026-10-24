import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The music folder is read when the module loads, so point it at a temporary folder first.
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-seek-test-'));
process.env.MUSIC_DIR = musicDir;
const { SeekRateLimitedError, VoiceBot } = await import('./voice-bot.js');

/** `cooldown` and `resumeCooldown` are the rate limits in seconds; the tests that repeat an action turn them off. */
function makeBot(cooldown = 0, resumeCooldown = 0): InstanceType<typeof VoiceBot> {
  return new VoiceBot({
    seekCooldownSec: cooldown,
    resumeCooldownSec: resumeCooldown,
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
    stopSource: async () => undefined,
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

  it('resumes a paused remote video inside the cooldown, and the resume does not use it up', async () => {
    const bot = makeBot(120);
    const { b, sources } = fakeVideo(bot, { duration: 5470 });

    await bot.seek(1800);
    mock.timers.tick(10_000);
    await bot.pauseVideo();
    await bot.resumeVideo();
    assert.equal(bot.videoPaused, false);
    assert.deepEqual(sources.map((x) => x.options.startSeconds), [1800, 1810], 'resumed at the paused position');

    // The resume left the clock where the seek set it: 10 s later a seek is still refused for the rest.
    await assert.rejects(() => bot.seek(2400), (err: unknown) =>
      err instanceof SeekRateLimitedError && err.retryAfterSec === 110);
    b.clearVideoEndTimer();
  });

  it('keeps a short floor between two resumes of a remote video, then lets the next one through', async () => {
    const bot = makeBot(120, 10);
    const { b, sources } = fakeVideo(bot, { duration: 5470 });

    await bot.seek(1800);
    await bot.pauseVideo();
    await bot.resumeVideo();
    await bot.pauseVideo();
    mock.timers.tick(4_000);
    await assert.rejects(() => bot.resumeVideo(), (err: unknown) =>
      err instanceof SeekRateLimitedError && err.kind === 'resume' && err.retryAfterSec === 6 && err.cooldownSec === 10
      && /Resuming a remote video is limited to once every 10 seconds/.test(err.message));
    assert.equal(bot.videoPaused, true, 'a refused resume leaves the video paused');
    assert.equal(sources.length, 2, 'and does not reopen the site');

    mock.timers.tick(6_000);
    await bot.resumeVideo();
    assert.equal(bot.videoPaused, false);
    assert.equal(sources.length, 3);
    b.clearVideoEndTimer();
  });

  it('a resume floor of 0 turns it off, and the floor never applies to a video on disk', async () => {
    const off = makeBot(120, 0);
    const a = fakeVideo(off, { duration: 5470 });
    await off.pauseVideo();
    await off.resumeVideo();
    await off.pauseVideo();
    await off.resumeVideo();
    assert.equal(a.sources.length, 2);
    a.b.clearVideoEndTimer();

    fs.writeFileSync(path.join(musicDir, '.stream-1.mp4'), '');
    const local = makeBot(120, 10);
    const l = fakeVideo(local, { duration: 5470 });
    l.b._videoTempFile = '.stream-1.mp4';
    await local.pauseVideo();
    await local.resumeVideo();
    await local.pauseVideo();
    await local.resumeVideo();
    assert.equal(l.sources.length, 2, 'two resumes in a row from the local copy');
    l.b.clearVideoEndTimer();
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
