import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ts3Client } from './client.js';

function feed(client: Ts3Client, cmdStr: string) {
  (client as any).processCommand(Buffer.from(cmdStr, 'utf-8'));
}

test('the nickname the server assigns in initserver is remembered', () => {
  const client = new Ts3Client();
  (client as any).sendCommand = () => {};
  const seen: string[] = [];
  client.on('nickname', (n: string) => seen.push(n));
  assert.equal(client.getAssignedNickname(), '');
  feed(client, 'initserver virtualserver_name=Test aclid=9 acn=Bot1');
  assert.equal(client.getAssignedNickname(), 'Bot1');
  assert.deepEqual(seen, ['Bot1']);
  (client as any).cleanup();
});

test('our own enter-view and later updates change the remembered nickname, other clients do not', () => {
  const client = new Ts3Client();
  (client as any).clientId = 9;
  (client as any).currentChannelId = 20;
  (client as any).sendCommand = () => {};
  feed(client, 'notifycliententerview clid=4 ctid=20 client_type=0 client_nickname=Someone');
  assert.equal(client.getAssignedNickname(), '');
  feed(client, 'notifycliententerview clid=9 ctid=20 client_type=0 client_nickname=Bot1');
  assert.equal(client.getAssignedNickname(), 'Bot1');
  feed(client, 'notifyclientupdated clid=4 client_nickname=Other');
  assert.equal(client.getAssignedNickname(), 'Bot1');
  feed(client, 'notifyclientupdated clid=9 client_nickname=Bot');
  assert.equal(client.getAssignedNickname(), 'Bot');
});
