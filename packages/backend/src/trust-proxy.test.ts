import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { applyTrustProxy, describeTrustProxy, forwardedHeaderWarning, parseTrustProxy } from './trust-proxy.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, '../../..');


/** Evaluate the TRUST_PROXY default line of an image entrypoint with a given inherited env. */
function entrypointTrustProxy(script: string, inherited: string | undefined): string {
  const line = readFileSync(resolve(repoDir, 'docker-commands', script), 'utf8')
    .split('\n').find(l => l.startsWith('export TRUST_PROXY='));
  assert.ok(line, `${script} sets no TRUST_PROXY default`);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  if (inherited !== undefined) env.TRUST_PROXY = inherited;
  const out = spawnSync('sh', ['-c', `${line}\nprintf %s "$TRUST_PROXY"`], { env, encoding: 'utf8' });
  return out.stdout;
}

describe('parseTrustProxy', () => {
  it('trusts nothing when unset or blank', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy(' , '), false);
  });

  it('parses explicit lists, trimming entries', () => {
    assert.deepEqual(parseTrustProxy('loopback'), ['loopback']);
    assert.deepEqual(parseTrustProxy(' 10.0.0.0/8 , uniquelocal'), ['10.0.0.0/8', 'uniquelocal']);
  });

  it('accepts explicit none words, case-insensitively', () => {
    for (const word of ['false', 'none', 'off', 'no', 'NONE', 'False']) assert.equal(parseTrustProxy(word), false);
  });

  it('rejects mixing none with addresses', () => {
    assert.throws(() => parseTrustProxy('none,loopback'), /mixes/);
  });

  it('rejects boolean and hop-count values', () => {
    for (const value of ['true', '1', '2', 'loopback,3']) assert.throws(() => parseTrustProxy(value), /not supported/);
  });

  it('describes the effective setting for the startup log', () => {
    assert.match(describeTrustProxy(false), /none/);
    assert.equal(describeTrustProxy(['loopback', '10.0.0.0/8']), 'loopback, 10.0.0.0/8');
    assert.match(describeTrustProxy('private-peer'), /^private-peer \(one hop, only when the connecting peer has a private address\)$/);
  });

  it('parses private-peer on its own and rejects mixing it with addresses', () => {
    assert.equal(parseTrustProxy('private-peer'), 'private-peer');
    assert.equal(parseTrustProxy(' Private-Peer '), 'private-peer');
    assert.throws(() => parseTrustProxy('private-peer,10.0.0.0/8'), /mixes "private-peer"/);
    assert.throws(() => parseTrustProxy('loopback,private-peer'), /mixes "private-peer"/);
  });

  it('hands explicit settings to Express unchanged', () => {
    const none = express();
    applyTrustProxy(none, false);
    assert.equal(none.get('trust proxy'), false);
    const list = ['uniquelocal', '203.0.113.7'];
    const explicit = express();
    applyTrustProxy(explicit, list);
    assert.equal(explicit.get('trust proxy'), list);
  });

  it('private-peer trusts a private socket peer and nothing further left', () => {
    const app = express();
    applyTrustProxy(app, 'private-peer');
    const trust = app.get('trust proxy fn') as (addr: string, hop: number) => boolean;
    for (const addr of ['10.1.2.3', '172.18.0.3', '::ffff:172.18.0.3', '192.168.1.9', 'fd00::5']) {
      assert.equal(trust(addr, 0), true, `peer ${addr}`);
      assert.equal(trust(addr, 1), false, `forwarded entry ${addr}`);
    }
    for (const addr of ['127.0.0.1', '::1', '8.8.8.8', '::ffff:203.0.113.7', '2001:db8::1']) assert.equal(trust(addr, 0), false, addr);
  });

  it('private-peer makes req.ip the right-most forwarded entry, and only behind a private peer', () => {
    const app = express();
    applyTrustProxy(app, 'private-peer');
    const ipFor = (peer: string, xff?: string) => {
      const req = Object.create(app.request) as express.Request;
      Object.assign(req, { app, socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
      return req.ip;
    };
    assert.equal(ipFor('172.18.0.3', '198.51.100.10'), '198.51.100.10');
    assert.equal(ipFor('172.18.0.3', '203.0.113.9, 192.168.1.50'), '192.168.1.50');
    assert.equal(ipFor('172.18.0.3', '203.0.113.9, 10.0.0.7, 172.18.0.10'), '172.18.0.10');
    assert.equal(ipFor('172.18.0.3'), '172.18.0.3');
    assert.equal(ipFor('198.51.100.40', '203.0.113.9'), '198.51.100.40');
    assert.equal(ipFor('127.0.0.1', '203.0.113.9'), '127.0.0.1');
  });
});

describe('image entrypoint defaults', () => {
  it('all-in-one defaults to loopback only', () => {
    assert.equal(entrypointTrustProxy('start-backend.sh', undefined), 'loopback');
    assert.equal(entrypointTrustProxy('start-backend.sh', ''), 'loopback');
  });

  it('split backend image defaults to one private hop', () => {
    assert.equal(entrypointTrustProxy('start-backend-standalone.sh', undefined), 'private-peer');
    assert.equal(entrypointTrustProxy('start-backend-standalone.sh', ''), 'private-peer');
  });

  it('an explicit TRUST_PROXY always wins, including "none"', () => {
    for (const script of ['start-backend.sh', 'start-backend-standalone.sh']) {
      assert.equal(entrypointTrustProxy(script, '172.18.0.0/16'), '172.18.0.0/16');
      assert.equal(entrypointTrustProxy(script, 'none'), 'none');
      assert.equal(entrypointTrustProxy(script, 'false'), 'false');
    }
  });

  it('uniquelocal trusts private peers but never public ones', () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy('uniquelocal'));
    const trust = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    for (const addr of ['10.1.2.3', '172.18.0.5', '192.168.1.9', 'fd00::5']) assert.equal(trust(addr, 0), true, addr);
    for (const addr of ['8.8.8.8', '203.0.113.7', '2001:db8::1']) assert.equal(trust(addr, 0), false, addr);
  });
});

describe('forwardedHeaderWarning', () => {
  const run = (setting: false | string[], headers: Record<string, string>, times = 3) => {
    const messages: string[] = [];
    const mw = forwardedHeaderWarning(setting, m => messages.push(m));
    for (let i = 0; i < times; i++) mw({ headers } as never, {} as never, () => undefined);
    return messages;
  };

  it('warns once when a forwarded header arrives and nothing is trusted, without echoing it', () => {
    const messages = run(false, { 'x-forwarded-for': '198.51.100.77' });
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0], /198\.51\.100\.77/);
  });

  it('stays quiet without the header or when a proxy is trusted', () => {
    assert.equal(run(false, {}).length, 0);
    assert.equal(run(['loopback'], { 'x-forwarded-for': '198.51.100.77' }).length, 0);
  });
});
