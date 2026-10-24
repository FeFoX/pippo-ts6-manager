import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_VIDEO_START_OPTIONS, videoOptionsSummary, videoStartDefaults, videoStartRequest,
} from '../../src/lib/video-options';

describe('console video options', () => {
  it('inherits quality, encoder and timeout without overriding source detection', () => {
    assert.deepEqual(DEFAULT_VIDEO_START_OPTIONS, {
      quality: '', encoder: '', noViewerTimeout: '', sourceMode: 'auto', direct: false, encodeThreads: '', convertThreads: '', cpuPriority: '',
    });
    assert.deepEqual(videoStartRequest(DEFAULT_VIDEO_START_OPTIONS), { sourceMode: 'auto' });
  });

  it('keeps IPTV live while inheriting the streaming defaults', () => {
    assert.deepEqual(videoStartDefaults('live'), {
      quality: '', encoder: '', noViewerTimeout: '', sourceMode: 'live', direct: false, encodeThreads: '', convertThreads: '', cpuPriority: '',
    });
    assert.deepEqual(videoStartRequest(videoStartDefaults('live')), { sourceMode: 'live' });
  });

  it('passes explicit choices through', () => {
    assert.deepEqual(
      videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, quality: '1080p', encoder: 'h264_vaapi', noViewerTimeout: '600', sourceMode: 'live' }),
      { preset: '1080p', encoder: 'h264_vaapi', noViewerTimeoutSec: 600, sourceMode: 'live' },
    );
  });

  it('distinguishes explicit Auto from inheriting the defaults', () => {
    assert.deepEqual(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, quality: 'auto', encoder: 'auto' }), {
      preset: 'auto', encoder: 'auto', sourceMode: 'auto',
    });
  });

  it('inherits each field independently of explicit overrides', () => {
    assert.deepEqual(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, quality: '720p' }), {
      preset: '720p', sourceMode: 'auto',
    });
    assert.deepEqual(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, encoder: 'vp9' }), {
      encoder: 'vp9', sourceMode: 'auto',
    });
    assert.deepEqual(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, noViewerTimeout: '900' }), {
      noViewerTimeoutSec: 900, sourceMode: 'auto',
    });
  });

  it('asks for a direct stream only when it is switched on', () => {
    assert.equal('direct' in videoStartRequest(DEFAULT_VIDEO_START_OPTIONS), false);
    assert.equal(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, direct: true }).direct, true);
  });

  it('leaves the thread counts to the defaults until one is typed', () => {
    const request = videoStartRequest(DEFAULT_VIDEO_START_OPTIONS);
    assert.equal('encodeThreads' in request, false);
    assert.equal('convertThreads' in request, false);
  });

  it('sends a thread count, and 0 as an explicit automatic', () => {
    assert.deepEqual(
      videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, encodeThreads: '4', convertThreads: '0' }),
      { encodeThreads: 4, convertThreads: 0, sourceMode: 'auto' },
    );
    assert.deepEqual(
      videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, convertThreads: '2' }),
      { convertThreads: 2, sourceMode: 'auto' },
    );
  });

  it('sends a CPU priority only when one is chosen', () => {
    assert.equal('cpuPriority' in videoStartRequest(DEFAULT_VIDEO_START_OPTIONS), false);
    assert.equal(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, cpuPriority: 'lowest' }).cpuPriority, 'lowest');
    assert.equal(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, cpuPriority: 'normal' }).cpuPriority, 'normal');
  });

  it('sends 0 when the no-viewer stop is turned off', () => {
    assert.equal(videoStartRequest({ ...DEFAULT_VIDEO_START_OPTIONS, noViewerTimeout: '0' }).noViewerTimeoutSec, 0);
  });
});

describe('console video options summary', () => {
  it('identifies inherited defaults', () => {
    assert.equal(videoOptionsSummary(videoStartDefaults('live')),
      'Default quality · Default encoder · default auto-stop · Live');
  });

  it('says when the video is sent without re-encoding', () => {
    assert.equal(
      videoOptionsSummary({ ...videoStartDefaults('auto'), quality: '720p', direct: true }),
      '720p · Direct, no re-encoding · default auto-stop · Detect',
    );
  });

  it('names the thread counts that were set', () => {
    assert.equal(
      videoOptionsSummary({ ...videoStartDefaults('auto'), encodeThreads: '4', convertThreads: '0' }),
      'Default quality · Default encoder · default auto-stop · encode 4 threads · convert automatic · Detect',
    );
  });

  it('names an explicit CPU priority', () => {
    assert.equal(
      videoOptionsSummary({ ...videoStartDefaults('auto'), cpuPriority: 'low' }),
      'Default quality · Default encoder · default auto-stop · low CPU priority · Detect',
    );
  });

  it('names every explicit choice on one line', () => {
    assert.equal(
      videoOptionsSummary({ ...DEFAULT_VIDEO_START_OPTIONS, quality: '1080p', encoder: 'auto', noViewerTimeout: '0', sourceMode: 'live' }),
      '1080p · Auto encoder · no auto-stop · Live',
    );
    assert.equal(
      videoOptionsSummary({ ...DEFAULT_VIDEO_START_OPTIONS, quality: 'auto', encoder: 'auto', noViewerTimeout: '900' }),
      'Auto · Auto encoder · stops after 15 min · Detect',
    );
  });
});
