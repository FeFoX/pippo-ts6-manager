import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { applyTrustProxy, parseTrustProxy } from './trust-proxy.js';

/**
 * Hypothesis: an edge reverse proxy on the Docker bridge in front of the all-in-one image's nginx.
 * nginx appends the edge proxy's address to X-Forwarded-For and connects to the backend over
 * loopback, so the backend sees: peer 127.0.0.1, header "<client>, <edge proxy>".
 */
const EDGE = '172.17.0.1';
const CLIENT = '198.51.100.10';

function ipFor(trust: string | number, peer: string, xff?: string): string | undefined {
  const app = express();
  if (typeof trust === 'number') app.set('trust proxy', trust);
  else applyTrustProxy(app, parseTrustProxy(trust));
  const req = Object.create(app.request) as express.Request;
  Object.assign(req, { app, socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  return req.ip;
}

describe('client address behind an edge proxy and the all-in-one nginx', () => {
  it('REPRODUCTION: a hard-coded one hop keys every user on the edge proxy', () => {
    assert.equal(ipFor(1, '127.0.0.1', `${CLIENT}, ${EDGE}`), EDGE);
    assert.equal(ipFor(1, '127.0.0.1', `203.0.113.5, ${EDGE}`), EDGE);
  });

  it('the image default (loopback) stops at the edge proxy, so TRUST_PROXY must name it', () => {
    assert.equal(ipFor('loopback', '127.0.0.1', `${CLIENT}, ${EDGE}`), EDGE);
  });

  it('TRUST_PROXY=loopback,<edge proxy> keys on the client the edge proxy reported', () => {
    assert.equal(ipFor(`loopback,${EDGE}`, '127.0.0.1', `${CLIENT}, ${EDGE}`), CLIENT);
  });

  it('a client cannot choose its key by sending its own X-Forwarded-For', () => {
    // The edge proxy appends the real client after whatever the client sent.
    assert.equal(ipFor(`loopback,${EDGE}`, '127.0.0.1', `10.9.9.9, ${CLIENT}, ${EDGE}`), CLIENT);
  });
});
