import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { VoiceBot } from './voice-bot.js';

/** Advance in steps so retries scheduled by an earlier one fall inside the window. */
function advance(ms: number): void {
  for (let left = ms; left > 0; left -= 1_000) mock.timers.tick(Math.min(1_000, left));
}

function makeBot(shown: { nick: string }): { bot: VoiceBot; sent: string[] } {
  const bot = new VoiceBot({
    id: 7, serverConfigId: 1, name: 'test', serverHost: '127.0.0.1', serverPort: 9987, nickname: 'Bot', volume: 50,
  });
  const sent: string[] = [];
  const client = (bot as any).client;
  client.getAssignedNickname = () => shown.nick;
  client.sendCommand = (cmd: string) => { sent.push(cmd); };
  (bot as any)._status = 'connected';
  return { bot, sent };
}

describe('nickname taken at connect', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('asks again for the configured nickname until the server shows it', () => {
    const shown = { nick: 'Bot1' };
    const { bot, sent } = makeBot(shown);
    (bot as any).scheduleNicknameReclaim();

    mock.timers.tick(1_000);
    assert.deepEqual(sent, ['clientupdate client_nickname=Bot'], 'the first try');
    mock.timers.tick(3_000);
    assert.equal(sent.length, 2, 'still numbered: tried again');

    shown.nick = 'Bot';
    mock.timers.tick(8_000);
    assert.equal(sent.length, 2, 'done once the server shows the right nickname');
    advance(120_000);
    assert.equal(sent.length, 2);
  });

  it('gives up after five tries', () => {
    const { bot, sent } = makeBot({ nick: 'Bot1' });
    (bot as any).scheduleNicknameReclaim();
    advance(200_000);
    assert.equal(sent.length, 5);
  });

  it('sends nothing when the nickname is right or decorated by now playing', () => {
    for (const nick of ['Bot', 'Bot \u266A Some Song']) {
      const { bot, sent } = makeBot({ nick });
      (bot as any).scheduleNicknameReclaim();
      advance(200_000);
      assert.deepEqual(sent, [], `shown ${JSON.stringify(nick)}`);
    }
  });

  it('keeps trying while the nickname is unknown, sending nothing until it is', () => {
    const shown = { nick: '' };
    const { bot, sent } = makeBot(shown);
    (bot as any).scheduleNicknameReclaim();
    advance(8_000);
    assert.deepEqual(sent, [], 'unknown: nothing sent');

    shown.nick = 'Bot1'; // the server reports it late, e.g. from our own enter-view
    advance(5_000); // the attempt at 12 s
    assert.deepEqual(sent, ['clientupdate client_nickname=Bot'], 'the chain was still running');
  });

  it('says once, at the last attempt, that the nickname was never reported', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const { bot, sent } = makeBot({ nick: '' });
      (bot as any).scheduleNicknameReclaim();
      advance(200_000);
      assert.deepEqual(sent, []);
      assert.equal(warnings.filter((w) => w.includes('never reported')).length, 1);
    } finally {
      console.warn = original;
    }
  });

  it('stops when the bot is stopped or disconnects', async () => {
    const a = makeBot({ nick: 'Bot1' });
    (a.bot as any).scheduleNicknameReclaim();
    await a.bot.stop();
    const afterStop = a.sent.length;
    advance(200_000);
    assert.equal(a.sent.length, afterStop, 'no retry after stop');

    const b = makeBot({ nick: 'Bot1' });
    (b.bot as any).scheduleNicknameReclaim();
    (b.bot as any).client.emit('disconnected');
    advance(200_000);
    assert.deepEqual(b.sent, []);
  });
});
