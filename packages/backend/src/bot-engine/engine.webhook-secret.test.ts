import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BotEngine } from './engine.js';

const SECRET = 's3cret-value';

function engineWithWebhook() {
  const executed: string[] = [];
  const engine = Object.create(BotEngine.prototype) as any;
  engine.webhookEntries = [{ flowId: 1, nodeId: 'n1', path: 'notify', method: 'POST', secret: SECRET }];
  engine.flows = new Map([[1, { id: 1 }]]);
  engine.warnedQuerySecret = false;
  engine.executeFlow = (_flow: unknown, nodeId: string) => { executed.push(nodeId); };
  return { engine, executed };
}

function call(engine: any, headers: Record<string, string>, query: Record<string, string>) {
  let status = 200;
  let body: unknown;
  const res = { status(code: number) { status = code; return this; }, json(data: unknown) { body = data; return this; } };
  engine.handleWebhookRequest({ params: { path: 'notify' }, method: 'POST', headers, query, body: {} }, res);
  return { status, body };
}

describe('webhook secret', () => {
  it('runs the flow when the secret is in the X-Webhook-Secret header', () => {
    const { engine, executed } = engineWithWebhook();
    assert.deepEqual(call(engine, { 'x-webhook-secret': SECRET }, {}), { status: 200, body: { triggered: 1 } });
    assert.deepEqual(executed, ['n1']);
  });

  it('no longer accepts the secret in the query string, and warns once without logging it', (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const { engine, executed } = engineWithWebhook();
    assert.equal(call(engine, {}, { secret: SECRET }).status, 404);
    assert.equal(call(engine, {}, { secret: SECRET }).status, 404);
    assert.deepEqual(executed, []);
    assert.equal(warn.mock.callCount(), 1);
    assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), new RegExp(SECRET));
  });
});
