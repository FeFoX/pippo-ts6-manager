import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashRefreshToken, newRefreshToken, parseRefreshExpiry, purgeUnhashedRefreshTokens } from './refresh-token.js';

describe('parseRefreshExpiry', () => {
  it('reads the same units as JWT_ACCESS_EXPIRY', () => {
    assert.equal(parseRefreshExpiry('7d'), 7 * 86_400_000);
    assert.equal(parseRefreshExpiry('12h'), 12 * 3_600_000);
    assert.equal(parseRefreshExpiry('30m'), 30 * 60_000);
    assert.equal(parseRefreshExpiry(' 2W '), 2 * 604_800_000);
    assert.equal(parseRefreshExpiry('90s'), 90_000);
  });

  it('refuses values that would silently mean something else', () => {
    for (const value of ['', '7', '0d', '7 days', '1.5d', '-1d', 'forever']) {
      assert.throws(() => parseRefreshExpiry(value), /JWT_REFRESH_EXPIRY/, value);
    }
  });
});

describe('refresh token hashing', () => {
  it('hands out a random token and stores its 64-character SHA-256', () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    assert.equal(a.token.length, 128);
    assert.equal(a.hash.length, 64);
    assert.equal(a.hash, hashRefreshToken(a.token));
    assert.notEqual(a.token, b.token);
  });

  it('purges rows that still hold a token instead of a hash', async () => {
    const queries: string[] = [];
    const removed = await purgeUnhashedRefreshTokens({ $executeRawUnsafe: async (q) => { queries.push(q); return 3; } });
    assert.equal(removed, 3);
    assert.match(queries[0], /DELETE FROM "RefreshToken" WHERE length\("token"\) <> 64/);
  });
});
