import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_VIDEO_THREADS, cpuPriorityLabel, inheritPriorityLabel, inheritThreadsLabel, isCpuPriority, parseThreadsInput, runningResourcesLabel, sanitizeThreadsInput,
  threadsLabel, threadsToInput,
} from '../../src/lib/video-resources';

describe('video thread input', () => {
  it('keeps digits, drops leading zeros and clamps to the maximum', () => {
    assert.equal(sanitizeThreadsInput(''), '');
    assert.equal(sanitizeThreadsInput('abc'), '');
    assert.equal(sanitizeThreadsInput('4x'), '4');
    assert.equal(sanitizeThreadsInput('0'), '0');
    assert.equal(sanitizeThreadsInput('007'), '7');
    assert.equal(sanitizeThreadsInput('-3'), '3');
    assert.equal(sanitizeThreadsInput('999'), String(MAX_VIDEO_THREADS));
  });

  it('reads an empty field as inherit and 0 as an explicit automatic', () => {
    assert.equal(parseThreadsInput(''), null);
    assert.equal(parseThreadsInput('  '), null);
    assert.equal(parseThreadsInput('0'), 0);
    assert.equal(parseThreadsInput('64'), 64);
    assert.equal(parseThreadsInput('65'), null);
    assert.equal(parseThreadsInput('1.5'), null);
  });

  it('turns a stored value back into field text', () => {
    assert.equal(threadsToInput(null), '');
    assert.equal(threadsToInput(undefined), '');
    assert.equal(threadsToInput(0), '0');
    assert.equal(threadsToInput(6), '6');
  });
});

describe('video thread labels', () => {
  it('names a count or automatic', () => {
    assert.equal(threadsLabel(0), 'automatic');
    assert.equal(threadsLabel(1), '1 thread');
    assert.equal(threadsLabel(4), '4 threads');
  });

  it('shows what an empty field inherits', () => {
    assert.equal(inheritThreadsLabel(undefined), 'Use default');
    assert.equal(inheritThreadsLabel(0), 'Use default (automatic)');
    assert.equal(inheritThreadsLabel(3), 'Use default (3)');
  });

  it('reports what a running stream uses, nothing when idle', () => {
    assert.equal(runningResourcesLabel(null), null);
    assert.equal(runningResourcesLabel({ encodeThreads: 0, convertThreads: 0, cpuPriority: 'normal' }), null);
    assert.equal(runningResourcesLabel({ encodeThreads: 4, convertThreads: 0 }), 'encode 4');
    assert.equal(runningResourcesLabel({ encodeThreads: 4, convertThreads: 2, cpuPriority: 'normal' }), 'encode 4 · convert 2');
    assert.equal(runningResourcesLabel({ encodeThreads: 4, convertThreads: 2, cpuPriority: 'lowest' }),
      'encode 4 · convert 2 · lowest priority');
    assert.equal(runningResourcesLabel({}), null);
  });

  it('names the CPU priorities and what an empty choice inherits', () => {
    assert.equal(cpuPriorityLabel('low'), 'Low');
    assert.equal(inheritPriorityLabel(undefined), 'Use default');
    assert.equal(inheritPriorityLabel('lowest'), 'Use default (Lowest)');
    assert.equal(isCpuPriority('low'), true);
    assert.equal(isCpuPriority('high'), false);
    assert.equal(isCpuPriority(null), false);
  });
});
