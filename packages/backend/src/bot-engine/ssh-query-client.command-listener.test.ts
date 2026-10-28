import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SshQueryClient, parseWhoamiIdentity } from './ssh-query-client.js';

const WHOAMI = 'virtualserver_status=online virtualserver_id=1 client_channel_id=1 client_nickname=Query client_id=12';

test('parseWhoamiIdentity reads client id and channel from a single-line reply', () => {
  assert.deepEqual(parseWhoamiIdentity(WHOAMI), { clid: 12, cid: 1 });
});

test('parseWhoamiIdentity finds the client id on a later line', () => {
  assert.deepEqual(parseWhoamiIdentity(`virtualserver_status=online\n${WHOAMI}`), { clid: 12, cid: 1 });
});

test('parseWhoamiIdentity returns null when no line has a client id', () => {
  assert.equal(parseWhoamiIdentity(''), null);
  assert.equal(parseWhoamiIdentity('virtualserver_status=online virtualserver_id=1'), null);
});

/** Client whose Query replies come from `reply`; records every command sent. */
function scriptedClient(reply: (cmd: string, sent: string[]) => string) {
  const client = new SshQueryClient({ host: 'ts.example.test', port: 10022, username: 'q', password: 'p' } as any) as any;
  const sent: string[] = [];
  client.executeCommand = async (cmd: string) => {
    sent.push(cmd);
    return reply(cmd, sent);
  };
  return { client, sent };
}

test('command listener moves into its channel when whoami has an extra line first', async () => {
  let cid = 1;
  const { client, sent } = scriptedClient((cmd) => {
    if (cmd === 'whoami') return `virtualserver_status=online\n${WHOAMI.replace('client_channel_id=1', `client_channel_id=${cid}`)}`;
    if (cmd.startsWith('clientmove')) cid = 5;
    return '';
  });

  await client.registerCommandListener(1, 5);

  assert.ok(sent.includes('clientmove clid=12 cid=5'));
  assert.ok(sent.includes('servernotifyregister event=textchannel id=5'));
});

test('command listener already in its channel skips the move', async () => {
  const { client, sent } = scriptedClient((cmd) =>
    cmd === 'whoami' ? WHOAMI.replace('client_channel_id=1', 'client_channel_id=5') : '');

  await client.registerCommandListener(1, 5);

  assert.equal(sent.some((c) => c.startsWith('clientmove')), false);
  assert.ok(sent.includes('servernotifyregister event=textchannel id=5'));
});

test('whoami is asked again once when the first reply has no client id', async () => {
  let whoamis = 0;
  let cid = 1;
  const { client, sent } = scriptedClient((cmd) => {
    if (cmd === 'whoami') {
      whoamis += 1;
      return whoamis === 1 ? '' : WHOAMI.replace('client_channel_id=1', `client_channel_id=${cid}`);
    }
    if (cmd.startsWith('clientmove')) cid = 5;
    return '';
  });

  await client.registerCommandListener(1, 5);

  assert.ok(sent.includes('clientmove clid=12 cid=5'));
});

test('registration fails instead of reporting ready when the client id never shows up', async () => {
  const { client, sent } = scriptedClient((cmd) => (cmd === 'whoami' ? 'virtualserver_status=online' : ''));

  await assert.rejects(client.registerCommandListener(1, 5), /whoami reply has no client id \(1 line\(s\): virtualserver_status\)/);
  assert.equal(sent.filter((c) => c === 'whoami').length, 2);
  assert.equal(sent.some((c) => c.startsWith('servernotifyregister')), false);
});

test('registration fails when the client is still elsewhere after the move', async () => {
  const { client, sent } = scriptedClient((cmd) => (cmd === 'whoami' ? WHOAMI : ''));

  await assert.rejects(client.registerCommandListener(1, 5), /in channel 1, not 5/);
  assert.equal(sent.some((c) => c.startsWith('servernotifyregister')), false);
});
