/**
 * CPU settings of a video stream: encode threads, convert threads and CPU priority.
 * They are set per server, per bot and per stream start. An empty field inherits, 0 threads
 * is an explicit "automatic", and 1 to 64 pins the count. Only the global default always has a value.
 */

import type { VideoCpuPriority } from '@ts6/common';

export const MAX_VIDEO_THREADS = 64;

/** The settings a stream resolves to, as the backend reports them. */
export interface VideoResources {
  encodeThreads: number;
  convertThreads: number;
  cpuPriority: VideoCpuPriority;
}

export const CPU_PRIORITY_OPTIONS: { value: VideoCpuPriority; label: string; hint: string }[] = [
  { value: 'normal', label: 'Normal', hint: 'ffmpeg ranks like any other process' },
  { value: 'low', label: 'Low', hint: 'yields to other work on the host' },
  { value: 'lowest', label: 'Lowest', hint: 'only uses CPU that nothing else wants' },
];

export function isCpuPriority(value: unknown): value is VideoCpuPriority {
  return CPU_PRIORITY_OPTIONS.some((o) => o.value === value);
}

export function cpuPriorityLabel(value: VideoCpuPriority): string {
  return CPU_PRIORITY_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** Keep digits only and clamp to the maximum, so a typed value is never out of range. */
export function sanitizeThreadsInput(text: string): string {
  const digits = text.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  if (digits === '') return '';
  return Number(digits) > MAX_VIDEO_THREADS ? String(MAX_VIDEO_THREADS) : digits;
}

/** null for an empty field (inherit), otherwise the whole number from 0 to the maximum. */
export function parseThreadsInput(text: string): number | null {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n <= MAX_VIDEO_THREADS ? n : null;
}

/** The field text for a stored value; null or absent means inherit. */
export function threadsToInput(value: number | null | undefined): string {
  return value == null ? '' : String(value);
}

/** "automatic" or "4 threads". */
export function threadsLabel(n: number): string {
  return n > 0 ? `${n} thread${n === 1 ? '' : 's'}` : 'automatic';
}

/** Placeholder for an empty thread field: what it inherits right now. */
export function inheritThreadsLabel(inherited: number | null | undefined): string {
  if (inherited == null) return 'Use default';
  return `Use default (${inherited > 0 ? inherited : 'automatic'})`;
}

/** Label of the empty choice in a CPU priority list. */
export function inheritPriorityLabel(inherited: VideoCpuPriority | null | undefined): string {
  return inherited ? `Use default (${cpuPriorityLabel(inherited)})` : 'Use default';
}

/**
 * What a running stream resolved to: "encode 4 · convert automatic · low priority". The backend reports 0
 * for automatic, so a running stream always names all three. Null when nothing is streaming or the backend
 * does not report them.
 */
export function runningResourcesLabel(
  v: { streaming?: boolean; encodeThreads?: number; convertThreads?: number; cpuPriority?: VideoCpuPriority } | null | undefined,
): string | null {
  if (!v || !v.streaming || v.encodeThreads == null || v.convertThreads == null || !v.cpuPriority) return null;
  const count = (n: number) => (n > 0 ? String(n) : 'automatic');
  return `encode ${count(v.encodeThreads)} · convert ${count(v.convertThreads)} · ${cpuPriorityLabel(v.cpuPriority).toLowerCase()} priority`;
}
