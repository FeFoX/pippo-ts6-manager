import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleStream, handleStreamDirect } from './streaming.js';
import { handlePause } from './playback.js';
import { SeekRateLimitedError } from '../voice-bot.js';

function setup(botOverrides: Record<string, unknown> = {}) {
  const replies: string[] = [];
  const started: Array<{ url: string; options: any }> = [];
  const changed: string[] = [];
  const bot: any = {
    status: 'connected',
    videoStreaming: false,
    videoDirectRequested: false,
    videoPaused: false,
    canPauseVideo: true,
    videoStreamStatus: { direct: true, directFallback: null },
    setVideoSource: async (url: string) => { changed.push(url); },
    pauseVideo: async () => { bot.videoPaused = true; },
    resumeVideo: async () => { bot.videoPaused = false; },
    ...botOverrides,
  };
  const context: any = {
    reply: (_bot: unknown, _clid: number, text: string) => { replies.push(text); },
    chatVideoSwitch: () => ({ replaceSessionIds: [] }),
    streamStartError: (err: any) => err.message,
    voiceBotManager: {
      startVideoStream: async (_bot: unknown, url: string, options: unknown) => { started.push({ url, options }); },
    },
  };
  return { bot, context, replies, started, changed };
}

describe('!streamdirect', () => {
  it('starts a direct stream and says the video is copied', async () => {
    const { bot, context, replies, started } = setup();
    await handleStreamDirect(context, bot, 1, 'https://www.youtube.com/watch?v=abc 720p');
    assert.equal(started.length, 1);
    assert.equal(started[0].options.direct, true);
    assert.equal(started[0].options.preset, '720p');
    assert.match(replies.at(-1)!, /Video stream started: .*direct: the video is copied, not re-encoded/);
  });

  it('says why when the video had to be re-encoded', async () => {
    const { bot, context, replies } = setup({
      videoStreamStatus: { direct: false, directFallback: 'Direct stream not possible: the video uses B-frames. The video is re-encoded.' },
    });
    await handleStreamDirect(context, bot, 1, 'https://www.youtube.com/watch?v=abc');
    assert.match(replies.at(-1)!, /B-frames/);
  });

  it('plain !stream never asks for direct', async () => {
    const { bot, context, started, replies } = setup();
    await handleStream(context, bot, 1, 'https://www.youtube.com/watch?v=abc');
    assert.equal('direct' in started[0].options, false);
    assert.doesNotMatch(replies.at(-1)!, /direct/i);
  });

  it('explains itself without an address', async () => {
    const { bot, context, replies, started } = setup();
    await handleStreamDirect(context, bot, 1, '');
    assert.equal(started.length, 0);
    assert.match(replies[0], /!streamdirect <url>/);
  });

  it('changes the source of a stream already started direct', async () => {
    const { bot, context, changed, started } = setup({ videoStreaming: true, videoDirectRequested: true });
    await handleStreamDirect(context, bot, 1, 'https://www.youtube.com/watch?v=def');
    assert.deepEqual(changed, ['https://www.youtube.com/watch?v=def']);
    assert.equal(started.length, 0);
  });

  it('does not silently turn a running stream into a direct one', async () => {
    const { bot, context, replies, changed } = setup({ videoStreaming: true, videoDirectRequested: false });
    await handleStreamDirect(context, bot, 1, 'https://www.youtube.com/watch?v=def');
    assert.equal(changed.length, 0);
    assert.match(replies.at(-1)!, /!stopstream/);
  });
});

describe('!pause on a video', () => {
  it('pauses, then resumes, with the same command', async () => {
    const { bot, context, replies } = setup({ videoStreaming: true });
    await handlePause(context, bot, 1);
    assert.equal(bot.videoPaused, true);
    assert.equal(replies.at(-1), 'Paused.');
    await handlePause(context, bot, 1);
    assert.equal(bot.videoPaused, false);
    assert.equal(replies.at(-1), 'Resumed.');
  });

  it('explains why a live stream cannot be paused', async () => {
    const { bot, context, replies } = setup({ videoStreaming: true, canPauseVideo: false });
    await handlePause(context, bot, 1);
    assert.match(replies.at(-1)!, /cannot be paused/);
  });

  it('tells the user to wait when resuming is limited by the seek cooldown', async () => {
    const { bot, context, replies } = setup({
      videoStreaming: true,
      videoPaused: true,
      resumeVideo: async () => { throw new SeekRateLimitedError(45, 120); },
    });
    await handlePause(context, bot, 1);
    assert.match(replies.at(-1)!, /still paused.*45s/);
  });

  it('keeps pausing music as before', async () => {
    let paused = false;
    const { bot, context, replies } = setup({ status: 'playing', pause: () => { paused = true; } });
    await handlePause(context, bot, 1);
    assert.equal(paused, true);
    assert.equal(replies.at(-1), 'Paused.');
  });
});
