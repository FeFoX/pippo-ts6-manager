/**
 * How long a convert-first conversion may take before the bot gives up on it and re-encodes the
 * video while it plays. The sidecar stops a conversion after three hours; waiting that long on a
 * stalled ffmpeg leaves the bot "starting" with nothing to tell the person who asked.
 */

/** A conversion is dropped when its progress has not moved for this long. */
export const CONVERT_STALL_MS = 5 * 60_000;
/** The shortest total time a conversion is given, however short the video. */
export const CONVERT_MIN_DEADLINE_MS = 10 * 60_000;
/** The sidecar's own limit (convert.go: convertTimeout). */
export const CONVERT_MAX_DEADLINE_MS = 3 * 60 * 60_000;
/** A conversion slower than half real time is not worth waiting for. */
const CONVERT_MIN_SPEED = 0.5;
/** The reported speed is noisy while a conversion starts; the projection is trusted after this long. */
export const CONVERT_PROJECTION_AFTER_MS = 30_000;

/** The longest total time a conversion of a video `durationSec` long is given. */
export function convertDeadlineMs(durationSec: number): number {
  const wanted = (durationSec / CONVERT_MIN_SPEED) * 1000;
  return Math.min(CONVERT_MAX_DEADLINE_MS, Math.max(CONVERT_MIN_DEADLINE_MS, wanted));
}

export interface ConvertProgress {
  /** Time since the conversion started. */
  elapsedMs: number;
  /** Time since the progress last moved. */
  stalledMs: number;
  /** Seconds left at the reported speed, when both are known. */
  etaSec: number | null;
}

/** Why a conversion should be abandoned, or null to keep waiting. */
export function convertGiveUpReason(progress: ConvertProgress, durationSec: number): string | null {
  const deadline = convertDeadlineMs(durationSec);
  if (progress.stalledMs >= CONVERT_STALL_MS) {
    return `the conversion made no progress for ${Math.round(CONVERT_STALL_MS / 60_000)} minutes`;
  }
  if (progress.elapsedMs >= deadline) {
    return `the conversion took longer than ${Math.round(deadline / 60_000)} minutes`;
  }
  if (
    progress.elapsedMs >= CONVERT_PROJECTION_AFTER_MS
    && progress.etaSec != null
    && progress.elapsedMs + progress.etaSec * 1000 > deadline
  ) {
    return `the conversion is too slow to finish within ${Math.round(deadline / 60_000)} minutes`;
  }
  return null;
}
