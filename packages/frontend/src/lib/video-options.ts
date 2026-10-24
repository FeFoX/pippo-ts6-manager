/**
 * Per-start video choices in the bot console (Link and IPTV tabs). They start
 * on the bot and server defaults and apply to one start only, so the
 * console never saves over the defaults.
 */

import type {
  StartVideoStreamRequest, VideoCpuPriority, VideoEncoderRequest, VideoQualityRequest, VideoSourceModeRequest,
} from '@ts6/common';
import { cpuPriorityLabel, parseThreadsInput, threadsLabel } from './video-resources';
import {
  ENCODER_OPTIONS, NO_VIEWER_TIMEOUT_OPTIONS, QUALITY_OPTIONS, SOURCE_MODE_OPTIONS, formatTimeout,
} from './video-streaming';

/** Empty quality, encoder or timeout means inherit; Auto is an explicit override. */
export interface VideoStartOptions {
  quality: VideoQualityRequest | '';
  encoder: VideoEncoderRequest | '';
  /** Timeout seconds as a string; "0" disables the no-viewer stop. */
  noViewerTimeout: string;
  sourceMode: VideoSourceModeRequest;
  /** Send the video without re-encoding it (H.264 files only; anything else is re-encoded). */
  direct: boolean;
  /** Encode threads as a string: "" inherits, "0" is automatic, "1" to "64" pins the count. */
  encodeThreads: string;
  /** Convert-first conversion threads, same convention as encodeThreads. */
  convertThreads: string;
  /** CPU priority; "" inherits. */
  cpuPriority: VideoCpuPriority | '';
}

/** Empty choices leave defaults to the backend at stream start. */
export function videoStartDefaults(sourceMode: VideoSourceModeRequest = 'auto'): VideoStartOptions {
  return { quality: '', encoder: '', noViewerTimeout: '', sourceMode, direct: false, encodeThreads: '', convertThreads: '', cpuPriority: '' };
}

export const DEFAULT_VIDEO_START_OPTIONS: VideoStartOptions = videoStartDefaults();

export function videoStartRequest(
  options: VideoStartOptions,
): Pick<StartVideoStreamRequest, 'preset' | 'encoder' | 'noViewerTimeoutSec' | 'sourceMode' | 'direct' | 'encodeThreads' | 'convertThreads' | 'cpuPriority'> {
  const encodeThreads = parseThreadsInput(options.encodeThreads);
  const convertThreads = parseThreadsInput(options.convertThreads);
  return {
    ...(options.direct ? { direct: true } : {}),
    ...(encodeThreads !== null ? { encodeThreads } : {}),
    ...(convertThreads !== null ? { convertThreads } : {}),
    ...(options.cpuPriority !== '' ? { cpuPriority: options.cpuPriority } : {}),
    ...(options.quality !== '' ? { preset: options.quality } : {}),
    ...(options.encoder !== '' ? { encoder: options.encoder } : {}),
    ...(options.noViewerTimeout !== '' ? { noViewerTimeoutSec: Number(options.noViewerTimeout) } : {}),
    sourceMode: options.sourceMode,
  };
}

/** "No auto-stop", "5 min", "15 min" for a no-viewer timeout in seconds. */
export function noViewerTimeoutLabel(value: string): string {
  if (value === '') return 'Use server default';
  return NO_VIEWER_TIMEOUT_OPTIONS.find((o) => o.value === value)?.label ?? formatTimeout(Number(value));
}

/** Show inherited defaults separately from explicit Auto choices. */
export function videoOptionsSummary(value: VideoStartOptions): string {
  const quality = QUALITY_OPTIONS.find((o) => o.value === value.quality)?.label ?? 'Default quality';
  const encoder = ENCODER_OPTIONS.find((o) => o.value === value.encoder)?.label ?? 'Default encoder';
  const parts = [quality, value.direct ? 'Direct, no re-encoding' : value.encoder === 'auto' ? 'Auto encoder' : encoder];
  if (value.noViewerTimeout !== '') {
    parts.push(value.noViewerTimeout === '0' ? 'no auto-stop' : `stops after ${noViewerTimeoutLabel(value.noViewerTimeout)}`);
  } else {
    parts.push('default auto-stop');
  }
  const encodeThreads = parseThreadsInput(value.encodeThreads);
  const convertThreads = parseThreadsInput(value.convertThreads);
  if (encodeThreads !== null) parts.push(`encode ${threadsLabel(encodeThreads)}`);
  if (convertThreads !== null) parts.push(`convert ${threadsLabel(convertThreads)}`);
  if (value.cpuPriority !== '') parts.push(`${cpuPriorityLabel(value.cpuPriority).toLowerCase()} CPU priority`);
  parts.push(SOURCE_MODE_OPTIONS.find((o) => o.value === value.sourceMode)?.label ?? value.sourceMode);
  return parts.join(' · ');
}
