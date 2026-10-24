import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_PLAYLIST_IMPORT,
  MAX_RESUME_COOLDOWN_SECONDS,
  MAX_SEEK_COOLDOWN_SECONDS,
  parseMaxPlaylistImportInput,
  parseMaxVideoDurationInput,
  parseResumeCooldownInput,
  parseSeekCooldownInput,
} from '../../src/lib/limits-input';

const NOT_WHOLE = ['', '   ', '1.5', '-1', '1e3', 'abc', '12s'];

describe('parseSeekCooldownInput', () => {
  it('accepts whole seconds from 0 to the maximum', () => {
    assert.equal(parseSeekCooldownInput('0'), 0);
    assert.equal(parseSeekCooldownInput('120'), 120);
    assert.equal(parseSeekCooldownInput(' 45 '), 45);
    assert.equal(parseSeekCooldownInput(String(MAX_SEEK_COOLDOWN_SECONDS)), MAX_SEEK_COOLDOWN_SECONDS);
  });

  it('rejects a cleared field instead of sending NaN, and anything out of range', () => {
    for (const bad of [...NOT_WHOLE, String(MAX_SEEK_COOLDOWN_SECONDS + 1)]) {
      assert.equal(parseSeekCooldownInput(bad), null, bad);
    }
  });
});

describe('parseResumeCooldownInput', () => {
  it('accepts whole seconds from 0 (off) to the maximum', () => {
    assert.equal(parseResumeCooldownInput('0'), 0);
    assert.equal(parseResumeCooldownInput('10'), 10);
    assert.equal(parseResumeCooldownInput(String(MAX_RESUME_COOLDOWN_SECONDS)), MAX_RESUME_COOLDOWN_SECONDS);
  });

  it('rejects an empty or non-whole value, and anything above the maximum', () => {
    for (const bad of [...NOT_WHOLE, String(MAX_RESUME_COOLDOWN_SECONDS + 1)]) {
      assert.equal(parseResumeCooldownInput(bad), null, bad);
    }
  });
});

describe('parseMaxVideoDurationInput', () => {
  it('accepts 0 (unlimited) and any whole number of seconds', () => {
    assert.equal(parseMaxVideoDurationInput('0'), 0);
    assert.equal(parseMaxVideoDurationInput('900'), 900);
    assert.equal(parseMaxVideoDurationInput('100000'), 100000);
  });

  it('rejects an empty or non-whole value', () => {
    for (const bad of NOT_WHOLE) assert.equal(parseMaxVideoDurationInput(bad), null, bad);
  });
});

describe('parseMaxPlaylistImportInput', () => {
  it('accepts 1 to 500', () => {
    assert.equal(parseMaxPlaylistImportInput('1'), 1);
    assert.equal(parseMaxPlaylistImportInput('250'), 250);
    assert.equal(parseMaxPlaylistImportInput(String(MAX_PLAYLIST_IMPORT)), MAX_PLAYLIST_IMPORT);
  });

  it('rejects 0, values above 500, and an empty or non-whole value', () => {
    for (const bad of [...NOT_WHOLE, '0', String(MAX_PLAYLIST_IMPORT + 1)]) {
      assert.equal(parseMaxPlaylistImportInput(bad), null, bad);
    }
  });
});
