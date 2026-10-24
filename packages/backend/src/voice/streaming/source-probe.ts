/**
 * Bounded ffprobe of a stream source's video resolution, used only by Auto
 * quality. Fixed presets never call this (some IPTV services allow a single
 * connection, and a probe is a second one).
 */

import { spawn } from 'child_process';
import type { SourceResolution } from './quality.js';

export const SOURCE_PROBE_TIMEOUT_MS = 10_000;

export type ProbeRunner = (args: string[], timeoutMs: number) => Promise<string | null>;

function runFfprobe(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('ffprobe', args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 16_000) stdout += chunk.toString();
    });
    proc.on('error', () => finish(null));
    proc.on('close', (code) => finish(code === 0 ? stdout : null));
  });
}

export function sourceProbeArgs(source: string): string[] {
  const args = ['-v', 'error'];
  if (/^https?:\/\//i.test(source)) {
    // Microseconds; bounds each network read so a dead source cannot hang the probe.
    args.push('-rw_timeout', '8000000');
  }
  args.push(
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    source,
  );
  return args;
}

export interface SourceProbe {
  resolution: SourceResolution | null;
  /** Finite duration in seconds; null for live sources (ffprobe reports none). */
  durationSec: number | null;
}

export function parseProbe(stdout: string | null): SourceProbe | null {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    const duration = Number(parsed.format?.duration);
    return {
      resolution: parseProbeResolution(stdout),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  } catch {
    return null;
  }
}

/** One bounded ffprobe for Auto quality and live/VOD detection; null on failure. */
export async function probeSource(
  source: string,
  run: ProbeRunner = runFfprobe,
  timeoutMs: number = SOURCE_PROBE_TIMEOUT_MS,
): Promise<SourceProbe | null> {
  if (!source || source.startsWith('-')) return null;
  return parseProbe(await run(sourceProbeArgs(source), timeoutMs));
}

export function parseProbeResolution(stdout: string | null): SourceResolution | null {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
    const s = parsed.streams?.[0];
    const width = Number(s?.width);
    const height = Number(s?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** Probe the first video stream's resolution; null on any failure or timeout. */
export async function probeSourceResolution(
  source: string,
  run: ProbeRunner = runFfprobe,
  timeoutMs: number = SOURCE_PROBE_TIMEOUT_MS,
): Promise<SourceResolution | null> {
  if (!source || source.startsWith('-')) return null;
  return parseProbeResolution(await run(sourceProbeArgs(source), timeoutMs));
}

/** Whether a local file's video can go to viewers without re-encoding, and if not, why. */
export interface DirectCheck {
  ok: boolean;
  /** Why the video must be re-encoded; null when ok. */
  reason: string | null;
  /** The codec that goes to viewers as it is; null when the video cannot be copied. */
  codec: 'h264' | 'vp9' | null;
  /** Length in seconds when the probe reported one (a live source has none). */
  durationSec?: number;
  /** The video's own bitrate in kbps when the probe reported one. */
  bitrateKbps?: number;
}

/** How many packets are read to look for frame reordering. */
const DIRECT_PROBE_PACKETS = 150;

export function directProbeArgs(path: string): string[] {
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,has_b_frames,bit_rate:packet=pts,dts:format=duration,bit_rate',
    '-read_intervals', `%+#${DIRECT_PROBE_PACKETS}`,
    '-of', 'json',
    path,
  ];
}

/** Profiles a TeamSpeak viewer can decode; 10-bit and 4:2:2 profiles are not among them. */
const DIRECT_PROFILES = new Set(['baseline', 'constrained baseline', 'main', 'high', 'constrained high']);

const NO_COPY = (reason: string): DirectCheck => ({ ok: false, reason, codec: null });

/**
 * Two codecs go to viewers as they are.
 *
 * H.264 (8-bit 4:2:0) only without B-frames: viewers decode packets in the order they arrive,
 * and a B-frame stream sends frames out of display order, so the order of timestamps would
 * break, and the picture with it.
 *
 * VP9 (profile 0, 8-bit 4:2:0) always: its hidden frames travel in the same packet as the
 * frame that follows them, so every packet is already in display order.
 */
export function parseDirectCheck(stdout: string | null): DirectCheck {
  const check = judgeDirect(stdout);
  const duration = durationOf(stdout);
  const bitrate = bitrateOf(stdout);
  return {
    ...check,
    ...(duration != null ? { durationSec: duration } : {}),
    ...(bitrate != null ? { bitrateKbps: bitrate } : {}),
  };
}

/** The reason a probe gave no verdict, as opposed to a verdict that the picture cannot be copied. */
export const NOT_INSPECTED = 'the video could not be inspected';

function durationOf(stdout: string | null): number | null {
  if (!stdout) return null;
  try {
    const n = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The video's bitrate in kbps: the stream's own figure, else the container's (which also counts
 * the audio, so it can only be too high). Null when the probe gave neither.
 */
function bitrateOf(stdout: string | null): number | null {
  if (!stdout) return null;
  try {
    const data = JSON.parse(stdout) as { streams?: Array<{ bit_rate?: string }>; format?: { bit_rate?: string } };
    for (const raw of [data.streams?.[0]?.bit_rate, data.format?.bit_rate]) {
      const bps = Number(raw);
      if (Number.isFinite(bps) && bps > 0) return Math.max(1, Math.round(bps / 1000));
    }
  } catch { /* the verdict already says the probe was unreadable */ }
  return null;
}

function judgeDirect(stdout: string | null): DirectCheck {
  if (!stdout) return NO_COPY(NOT_INSPECTED);
  let data: { streams?: Array<Record<string, unknown>>; packets?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(stdout);
  } catch {
    return NO_COPY(NOT_INSPECTED);
  }
  const stream = data.streams?.[0];
  if (!stream) return NO_COPY('the file has no video');
  const codec = String(stream.codec_name ?? '');
  if (codec !== 'h264' && codec !== 'vp9') {
    return NO_COPY(`the video is ${codec ? codec.toUpperCase() : 'not H.264 or VP9'}, and viewers only accept H.264 or VP9`);
  }
  if (String(stream.pix_fmt ?? '') !== 'yuv420p') {
    return NO_COPY(`the video is ${String(stream.pix_fmt ?? 'not 8-bit 4:2:0')}, and viewers only accept yuv420p`);
  }
  if (codec === 'vp9') {
    // The viewers are offered "profile-id=0"; profiles 1 to 3 are 4:4:4 or deeper than 8 bits.
    const vp9Profile = String(stream.profile ?? '').toLowerCase();
    if (vp9Profile !== '' && vp9Profile !== 'profile 0') {
      return NO_COPY(`the VP9 profile (${String(stream.profile)}) is not one viewers decode`);
    }
    return { ok: true, reason: null, codec: 'vp9' };
  }
  const profile = String(stream.profile ?? '').toLowerCase();
  if (!DIRECT_PROFILES.has(profile)) {
    return NO_COPY(`the H.264 profile (${String(stream.profile ?? 'unknown')}) is not one viewers decode`);
  }
  const reorder = Number(stream.has_b_frames);
  if (Number.isFinite(reorder) && reorder > 0) {
    return NO_COPY('the video uses B-frames, which viewers cannot play when copied');
  }
  // The header can say "no B-frames" while the packets still reorder: compare each
  // packet's display time with its decode time; they differ by a constant if there are none.
  const gaps = new Set<number>();
  for (const p of data.packets ?? []) {
    const pts = Number(p.pts);
    const dts = Number(p.dts);
    if (Number.isFinite(pts) && Number.isFinite(dts)) gaps.add(pts - dts);
  }
  if (gaps.size > 1) {
    return NO_COPY('the video uses B-frames, which viewers cannot play when copied');
  }
  return { ok: true, reason: null, codec: 'h264' };
}

/** One bounded ffprobe of a local file; a failure counts as "cannot copy". */
export async function checkDirectEligible(
  path: string,
  run: ProbeRunner = runFfprobe,
  timeoutMs: number = SOURCE_PROBE_TIMEOUT_MS,
): Promise<DirectCheck> {
  if (!path || path.startsWith('-')) return NO_COPY(NOT_INSPECTED);
  return parseDirectCheck(await run(directProbeArgs(path), timeoutMs));
}
