/**
 * Validate per-stream start overrides from API bodies. Unknown quality or
 * encoder values are rejected rather than silently replaced.
 */

import type { VideoStreamStartOptions } from '../voice-bot.js';
import { isPresetKey } from './types.js';
import { isEncoderId } from './encoders.js';
import { CPU_PRIORITIES, MAX_ENCODE_THREADS, parseCpuPriority, MAX_NO_VIEWER_TIMEOUT_SEC, parseBoundedInt } from '../../utils/app-settings.js';
import { parseReplaceSessionIds } from '../media-session.js';

export type ParsedStartOptions =
  | { ok: true; options: VideoStreamStartOptions }
  | { ok: false; error: string };

export function parseStreamStartOptions(body: Record<string, unknown> | null | undefined): ParsedStartOptions {
  const b = body ?? {};
  const options: VideoStreamStartOptions = {};

  if (b.preset != null && b.preset !== '') {
    if (b.preset !== 'auto' && !isPresetKey(b.preset)) {
      return { ok: false, error: 'preset must be auto, 480p, 720p, 1080p, 1440p or 2160p' };
    }
    options.preset = b.preset;
  }

  if (b.encoder != null && b.encoder !== '') {
    if (b.encoder !== 'auto' && !isEncoderId(b.encoder)) {
      return { ok: false, error: 'encoder must be auto or a known encoder id' };
    }
    options.encoder = b.encoder;
  }

  if (b.framerate != null && b.framerate !== '') {
    const fps = Number(b.framerate);
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
      return { ok: false, error: 'framerate must be an integer between 1 and 60' };
    }
    options.framerate = fps;
  }

  if (b.bitrate != null && b.bitrate !== '') {
    if (typeof b.bitrate !== 'string' || !/^\d{2,6}(?:\.\d+)?[kKmM]?$/.test(b.bitrate.trim())) {
      return { ok: false, error: 'bitrate must look like 2500k' };
    }
    options.bitrate = b.bitrate.trim();
  }

  if (b.volume != null && b.volume !== '') {
    const vol = Number(b.volume);
    if (!Number.isFinite(vol)) return { ok: false, error: 'volume must be a number' };
    options.volume = Math.max(0, Math.min(100, vol));
  }

  if (b.noViewerTimeoutSec != null && b.noViewerTimeoutSec !== '') {
    const sec = parseBoundedInt(b.noViewerTimeoutSec, MAX_NO_VIEWER_TIMEOUT_SEC);
    if (sec == null) {
      return { ok: false, error: `noViewerTimeoutSec must be 0–${MAX_NO_VIEWER_TIMEOUT_SEC} seconds` };
    }
    options.noViewerTimeoutSec = sec;
  }

  if (b.sourceMode != null && b.sourceMode !== '') {
    if (!['auto', 'live', 'vod'].includes(String(b.sourceMode))) {
      return { ok: false, error: 'sourceMode must be auto, live or vod' };
    }
    options.sourceMode = b.sourceMode as 'auto' | 'live' | 'vod';
  }

  if (b.direct != null && b.direct !== '') {
    if (typeof b.direct !== 'boolean') return { ok: false, error: 'direct must be true or false' };
    options.direct = b.direct;
  }

  for (const field of ['encodeThreads', 'convertThreads'] as const) {
    if (b[field] == null || b[field] === '') continue;
    const n = parseBoundedInt(b[field], MAX_ENCODE_THREADS);
    if (n == null) return { ok: false, error: `${field} must be 0–${MAX_ENCODE_THREADS} (0 = automatic)` };
    options[field] = n;
  }

  if (b.cpuPriority != null && b.cpuPriority !== '') {
    const v = parseCpuPriority(b.cpuPriority);
    if (v == null) return { ok: false, error: `cpuPriority must be ${CPU_PRIORITIES.join(', ')}` };
    options.cpuPriority = v;
  }

  const replace = parseReplaceSessionIds(b);
  if (replace.length > 0) options.replaceSessionIds = replace;

  return { ok: true, options };
}
