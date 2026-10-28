import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { SshQueryClient } from './ssh-query-client.js';
import { EventBridge, commandListenerRetryDelayMs } from './event-bridge.js';
import { BotEngine } from './engine.js';
import { MusicCommandHandler } from '../voice/music-command-handler.js';

/**
 * CMD listeners belong to whoever opened them. Music cleanup must not close a
 * BotEngine flow's listener, and a flow's listener that fails to connect or drops
 * is reopened with backoff while the flow still needs it.
 */

const CONFIG_ID = 9;
const SID = 1;
const FLOW_CHANNEL = 5;

type ConnectStep = 'ok' | 'fail' | { gate: Promise<void> };

let connectScript: ConnectStep[] = [];
let registerScript: Array<'ok' | 'fail'> = [];
let clients: SshQueryClient[] = [];
const original = {
  connect: SshQueryClient.prototype.connect,
  registerCommandListener: SshQueryClient.prototype.registerCommandListener,
};

beforeEach(() => {
  connectScript = [];
  registerScript = [];
  clients = [];
  SshQueryClient.prototype.connect = async function (this: any) {
    clients.push(this);
    const step = connectScript.shift() ?? 'ok';
    if (typeof step === 'object') await step.gate;
    if (step === 'fail') throw new Error('SSH connect timeout for test-host:10022');
    if (this.destroyed) return;
    this.connected = true;
    this.emit('ready');
  };
  SshQueryClient.prototype.registerCommandListener = async () => {
    if ((registerScript.shift() ?? 'ok') === 'fail') throw new Error('whoami reply has no client id (0 line(s))');
  };
});

afterEach(() => {
  SshQueryClient.prototype.connect = original.connect;
  SshQueryClient.prototype.registerCommandListener = original.registerCommandListener;
  mock.timers.reset();
});

const serverConfig = {
  id: CONFIG_ID,
  host: 'ts.example.test',
  sshPort: 10022,
  sshUsername: 'query',
  sshPassword: 'encrypted',
  sshHostKeyFingerprint: null,
};

function stubBridge(bridge: any): void {
  bridge.buildSshOptions = () => ({ host: serverConfig.host, port: serverConfig.sshPort });
  // Main SSH session is not under test: helper parking and session ownership are no-ops.
  bridge.retainSession = async () => true;
  bridge.releaseSession = async () => {};
  bridge.ensureHelperInChannel = async () => true;
  bridge.executeCommand = async () => 'clid=2 cid=7 client_type=0';
}

function makeBridge(): any {
  const bridge = new EventBridge({
    tsServerConfig: { findUnique: async () => serverConfig },
  } as any) as any;
  stubBridge(bridge);
  return bridge;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function startupFixture() {
  const prisma = {
    tsServerConfig: { findUnique: async () => serverConfig },
    appSetting: { findUnique: async () => null },
    chatCommand: { findMany: async () => [] },
    musicBot: {
      findMany: async () => [{ id: 1 }],
      findUnique: async () => ({
        id: 1,
        serverConfigId: CONFIG_ID,
        virtualServerId: SID,
        defaultChannel: '1',
        commandChannelIds: '[]',
      }),
    },
  } as any;

  const engine = new BotEngine(prisma, {} as any, { clients: new Set() } as any, {} as any) as any;
  const bridge = engine.eventBridge;
  stubBridge(bridge);

  const trigger = {
    id: 'cmd', type: 'trigger', position: { x: 0, y: 0 },
    data: { triggerType: 'command', commandPrefix: '!', commandName: 'record', channelId: String(FLOW_CHANNEL) },
  };
  engine.flows.set(2, {
    id: 2, name: 'channel-bound command', serverConfigId: CONFIG_ID, virtualServerId: SID,
    triggerNodes: [trigger], flowData: { nodes: [trigger], edges: [] },
  });

  const voiceBot = {
    status: 'connected',
    ts3ClientId: 101,
    getCurrentChannelId: () => 1,
  };
  const handler = new MusicCommandHandler(prisma, { getBot: () => voiceBot } as any) as any;
  handler.eventBridge = bridge;
  return { engine, bridge, handler };
}

test('startup: music bot with empty commandChannelIds keeps the flow CMD listener connected', async () => {
  const { engine, bridge, handler } = startupFixture();

  engine.syncCommandListenersForPair(CONFIG_ID, SID);
  await flush();
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), true);

  await handler.refreshAllBotChannels();
  await flush();

  assert.deepEqual(bridge.getCommandListenerChannelIds(CONFIG_ID, SID), [FLOW_CHANNEL]);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), true);
  assert.equal(clients.length, 1, 'the flow listener is neither closed nor reopened');
});

test('startup: music cleanup while the flow listener is still connecting leaves it connected', async () => {
  const { engine, bridge, handler } = startupFixture();
  let open!: () => void;
  connectScript = [{ gate: new Promise<void>((r) => { open = r; }) }];

  engine.syncCommandListenersForPair(CONFIG_ID, SID);
  await flush();
  await handler.refreshAllBotChannels();
  open();
  await flush();

  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), true);
  assert.equal(clients.length, 1);
});

test('music only closes the listeners music holds', async () => {
  const bridge = makeBridge();
  await bridge.connectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL, 'flow');
  await bridge.connectCommandListener(CONFIG_ID, SID, 6, 'music');
  await bridge.connectCommandListener(CONFIG_ID, SID, 7, 'flow');
  await bridge.connectCommandListener(CONFIG_ID, SID, 7, 'music');

  assert.deepEqual(bridge.getCommandListenerChannelIds(CONFIG_ID, SID, 'music').sort(), [6, 7]);
  for (const cid of bridge.getCommandListenerChannelIds(CONFIG_ID, SID, 'music')) {
    await bridge.disconnectCommandListener(CONFIG_ID, SID, cid, 'music');
  }

  assert.deepEqual(bridge.getCommandListenerChannelIds(CONFIG_ID, SID).sort(), [FLOW_CHANNEL, 7]);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), true);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, 7), true);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, 6), false);
});

test('a failed initial connect is retried with backoff while the flow needs it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = makeBridge();
  connectScript = ['fail', 'fail', 'ok'];

  await bridge.connectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), false);
  assert.deepEqual(bridge.getCommandListenerChannelIds(CONFIG_ID, SID), [FLOW_CHANNEL]);

  mock.timers.tick(commandListenerRetryDelayMs(1) - 1);
  await flush();
  assert.equal(clients.length, 1, 'no retry before the first backoff');
  mock.timers.tick(1);
  await flush();
  assert.equal(clients.length, 2);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), false);

  mock.timers.tick(commandListenerRetryDelayMs(2));
  await flush();
  assert.equal(clients.length, 3);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), true);
});

test('a dropped listener is reopened while the flow still needs it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = makeBridge();

  await bridge.connectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL);
  const first = clients[0] as any;
  first.connected = false;
  first.emit('close');
  assert.equal(first.destroyed, true, 'the dead client is replaced, not left reconnecting');
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), false);

  mock.timers.tick(commandListenerRetryDelayMs(1));
  await flush();
  assert.equal(clients.length, 2);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), true);
});

test('a listener that cannot join its channel is reopened with backoff', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = makeBridge();
  registerScript = ['fail', 'fail', 'ok'];

  await bridge.connectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL);
  await flush();
  assert.equal((clients[0] as any).destroyed, true, 'a listener outside its channel is not kept');
  assert.deepEqual(bridge.getCommandListenerChannelIds(CONFIG_ID, SID), [FLOW_CHANNEL]);

  mock.timers.tick(commandListenerRetryDelayMs(1));
  await flush();
  assert.equal(clients.length, 2);
  assert.equal((clients[1] as any).destroyed, true);

  // The backoff keeps growing while registration fails.
  mock.timers.tick(commandListenerRetryDelayMs(2) - 1);
  await flush();
  assert.equal(clients.length, 2);
  mock.timers.tick(1);
  await flush();
  assert.equal(clients.length, 3);
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), true);
});

test('no retry once the flow no longer needs the listener', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = makeBridge();
  connectScript = ['fail'];

  await bridge.connectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL);
  await bridge.disconnectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL);
  mock.timers.tick(commandListenerRetryDelayMs(10));
  await flush();

  assert.equal(clients.length, 1);
  assert.deepEqual(bridge.getCommandListenerChannelIds(CONFIG_ID, SID), []);
});

test('closing and reopening during a pending connect still ends connected', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const bridge = makeBridge();
  let open!: () => void;
  connectScript = [{ gate: new Promise<void>((r) => { open = r; }) }, 'ok'];

  const pending = bridge.connectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL);
  await flush();
  await bridge.disconnectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL);
  await bridge.connectCommandListener(CONFIG_ID, SID, FLOW_CHANNEL);
  open();
  await pending;
  await flush();

  mock.timers.tick(commandListenerRetryDelayMs(1));
  await flush();
  assert.equal(bridge.isCommandListenerConnected(CONFIG_ID, SID, FLOW_CHANNEL), true);
});

test('backoff doubles from 2s and caps at 60s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(commandListenerRetryDelayMs), [
    2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
  ]);
});
