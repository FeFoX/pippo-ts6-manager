import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RESUME_COOLDOWN_SEC, DEFAULT_SEEK_COOLDOWN_SEC, MAX_RESUME_COOLDOWN_SEC, MAX_SEEK_COOLDOWN_SEC,
  parseResumeCooldown, parseSeekCooldown,
} from './app-settings.js';

describe('seek cooldown setting', () => {
  it('defaults to two minutes when nothing valid is stored', () => {
    assert.equal(DEFAULT_SEEK_COOLDOWN_SEC, 120);
    for (const raw of [undefined, null, '', 'abc', '-5', '1.5', String(MAX_SEEK_COOLDOWN_SEC + 1)]) {
      assert.equal(parseSeekCooldown(raw), 120, String(raw));
    }
  });

  it('accepts whole seconds, and 0 turns the limit off', () => {
    assert.equal(parseSeekCooldown('30'), 30);
    assert.equal(parseSeekCooldown('0'), 0);
    assert.equal(parseSeekCooldown(String(MAX_SEEK_COOLDOWN_SEC)), MAX_SEEK_COOLDOWN_SEC);
  });
});

describe('resume cooldown setting', () => {
  it('defaults to ten seconds when nothing valid is stored', () => {
    assert.equal(DEFAULT_RESUME_COOLDOWN_SEC, 10);
    for (const raw of [undefined, null, '', 'abc', '-5', '1.5', String(MAX_RESUME_COOLDOWN_SEC + 1)]) {
      assert.equal(parseResumeCooldown(raw), 10, String(raw));
    }
  });

  it('accepts whole seconds, and 0 turns the limit off', () => {
    assert.equal(parseResumeCooldown('30'), 30);
    assert.equal(parseResumeCooldown('0'), 0);
    assert.equal(parseResumeCooldown(String(MAX_RESUME_COOLDOWN_SEC)), MAX_RESUME_COOLDOWN_SEC);
  });
});
