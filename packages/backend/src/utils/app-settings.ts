import { parseLocalHostAllowlist } from './url-validator.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { VideoCpuPriority, VideoDirectFallback, VideoEncodeProfile, VideoStreamPresetKey, VideoStreamSettings } from '@ts6/common';
import { VIDEO_STREAM_PRESET_KEYS } from '@ts6/common';
import { DEFAULT_AUTO_MAX_PRESET, isPresetKey } from '../voice/streaming/types.js';
import { MIN_PRESET_BITRATE_KBPS, TS_STREAM_MAX_KBPS, defaultPresetBitrates } from '../voice/streaming/quality.js';
import { isEncoderId, normalizeEncoderRequest } from '../voice/streaming/encoders.js';
import {
  DEFAULT_ENCODE_PROFILE,
  ENCODE_PROFILE_PRESETS,
  MAX_CPU_USED,
  MIN_CPU_USED,
  applyEncodeProfile,
  inferEncodeProfile,
  isEncodeProfile,
  isNamedEncodeProfile,
} from '../voice/streaming/encode-profiles.js';

export const MAX_VIDEO_DURATION_KEY = 'max_video_duration';
export const MAX_PLAYLIST_IMPORT_KEY = 'max_playlist_import';

export function parseVideoDuration(raw: string | null | undefined, fallback = 900): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function parseImportCap(raw: string | null | undefined, fallback = 250): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 500);
}

export async function loadMaxVideoDuration(prisma: PrismaClient): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: MAX_VIDEO_DURATION_KEY } });
  return parseVideoDuration(row?.value);
}

/** YouTube videos are streamed directly instead of downloaded first ('true' / 'false'). */
export const YOUTUBE_DIRECT_STREAM_KEY = 'youtube_direct_stream';

export async function loadYoutubeDirectStream(prisma: PrismaClient): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: YOUTUBE_DIRECT_STREAM_KEY } });
  return row?.value === 'true';
}

// === Bot access and seek cooldown ===

/** Server groups whose members may use the bot's chat commands (JSON array of names or ids). */
export const BOT_CONTROL_GROUPS_KEY = 'bot_control_groups';
/** Seconds between two seeks on a remote source. */
export const SEEK_COOLDOWN_KEY = 'seek_cooldown_seconds';

export const DEFAULT_SEEK_COOLDOWN_SEC = 120;
export const MAX_SEEK_COOLDOWN_SEC = 86_400;
/** Seconds between two resumes of a paused video that has to be opened again on its remote site. */
export const RESUME_COOLDOWN_KEY = 'resume_cooldown_seconds';
export const DEFAULT_RESUME_COOLDOWN_SEC = 10;
export const MAX_RESUME_COOLDOWN_SEC = 3_600;
const MAX_CONTROL_GROUPS = 20;
const MAX_CONTROL_GROUP_NAME_LENGTH = 100;

/** Seconds between remote seeks; 0 turns the limit off. Anything unreadable gives the default. */
export function parseSeekCooldown(raw: string | null | undefined, fallback = DEFAULT_SEEK_COOLDOWN_SEC): number {
  return parseBoundedInt(raw, MAX_SEEK_COOLDOWN_SEC) ?? fallback;
}

export async function loadSeekCooldownSec(prisma: PrismaClient): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: SEEK_COOLDOWN_KEY } });
  return parseSeekCooldown(row?.value);
}

/** Seconds between remote resumes; 0 turns the limit off. Anything unreadable gives the default. */
export function parseResumeCooldown(raw: string | null | undefined, fallback = DEFAULT_RESUME_COOLDOWN_SEC): number {
  return parseBoundedInt(raw, MAX_RESUME_COOLDOWN_SEC) ?? fallback;
}

export async function loadResumeCooldownSec(prisma: PrismaClient): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: RESUME_COOLDOWN_KEY } });
  return parseResumeCooldown(row?.value);
}

/** The stored list; a damaged value reads as "none". */
export function parseControlGroups(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map((g) => g.trim()) : [];
  } catch {
    return [];
  }
}

/** Validate an update from the panel: an array of group names or ids, without blanks or duplicates. */
export function parseControlGroupsUpdate(input: unknown): { ok: true; groups: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'controlGroups must be an array of server group names or ids' };
  const groups: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') return { ok: false, error: 'controlGroups must contain only text' };
    const name = entry.trim();
    if (!name) continue;
    if (name.length > MAX_CONTROL_GROUP_NAME_LENGTH) return { ok: false, error: 'A server group name is too long' };
    if (!groups.some((g) => g.toLowerCase() === name.toLowerCase())) groups.push(name);
  }
  if (groups.length > MAX_CONTROL_GROUPS) return { ok: false, error: `At most ${MAX_CONTROL_GROUPS} groups` };
  return { ok: true, groups };
}

export async function loadBotControlGroups(prisma: PrismaClient): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: BOT_CONTROL_GROUPS_KEY } });
  return parseControlGroups(row?.value);
}

export async function loadMaxPlaylistImport(prisma: PrismaClient): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: MAX_PLAYLIST_IMPORT_KEY } });
  return parseImportCap(row?.value);
}

// === Video streaming defaults (1.9.0) ===

export const VIDEO_NO_VIEWER_TIMEOUT_KEY = 'video_no_viewer_timeout';
export const VIDEO_ANNOUNCE_AUTO_STOPS_KEY = 'video_announce_auto_stops';
export const VIDEO_AUTO_MAX_PRESET_KEY = 'video_auto_max_preset';
export const VIDEO_DEFAULT_ENCODER_KEY = 'video_default_encoder';
export const VIDEO_PREFER_HARDWARE_KEY = 'video_prefer_hardware';
export const VIDEO_MAX_BITRATE_KEY = 'video_max_bitrate_kbps';
export const VIDEO_ENCODE_PROFILE_KEY = 'video_encode_profile';
export const VIDEO_CPU_USED_KEY = 'video_cpu_used';
export const VIDEO_ENCODE_THREADS_KEY = 'video_encode_threads';
export const VIDEO_CONVERT_THREADS_KEY = 'video_convert_threads';
export const VIDEO_CPU_PRIORITY_KEY = 'video_cpu_priority';
export const VIDEO_DIRECT_PACING_KEY = 'video_direct_pacing';
export const VIDEO_DIRECT_FALLBACK_KEY = 'video_direct_fallback';
/** JSON object with a bitrate in kbps for each resolution, e.g. {"720p":4000,"1080p":7000,...}. */
export const VIDEO_PRESET_BITRATES_KEY = 'video_preset_bitrates';

type PresetBitrates = Record<VideoStreamPresetKey, number>;

function validPresetBitrate(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= MIN_PRESET_BITRATE_KBPS && n <= TS_STREAM_MAX_KBPS ? n : null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
}

/** The valid entries of a stored bitrate map; invalid or unknown entries are dropped. */
export function parsePresetBitratesLenient(raw: unknown): Partial<PresetBitrates> {
  const obj = parseJsonObject(raw);
  const out: Partial<PresetBitrates> = {};
  if (!obj) return out;
  for (const key of VIDEO_STREAM_PRESET_KEYS) {
    const n = validPresetBitrate(obj[key]);
    if (n != null) out[key] = n;
  }
  return out;
}

/** A submitted bitrate map must give every resolution a whole number of kbps within the allowed range. */
export function parsePresetBitratesStrict(raw: unknown): { ok: true; value: PresetBitrates } | { ok: false; error: string } {
  const obj = parseJsonObject(raw);
  const range = `${MIN_PRESET_BITRATE_KBPS}–${TS_STREAM_MAX_KBPS} kbps`;
  if (!obj) return { ok: false, error: `presetBitrates must give a bitrate (${range}) for ${VIDEO_STREAM_PRESET_KEYS.join(', ')}` };
  const value = {} as PresetBitrates;
  for (const key of VIDEO_STREAM_PRESET_KEYS) {
    const n = validPresetBitrate(obj[key]);
    if (n == null) return { ok: false, error: `presetBitrates.${key} must be a whole number of ${range}` };
    value[key] = n;
  }
  return { ok: true, value };
}

/** Global settings with one server's overrides on top; a bitrate map is merged per resolution. */
export function mergeVideoSettings(global: VideoStreamSettings, overrides: Partial<VideoStreamSettings>): VideoStreamSettings {
  return {
    ...global,
    ...overrides,
    presetBitrates: { ...global.presetBitrates, ...overrides.presetBitrates },
  };
}

export const DIRECT_FALLBACKS: readonly VideoDirectFallback[] = ['live', 'ultrafast', 'superfast', 'veryfast'];
/** Convert first, with x264 ultrafast, unless the admin chooses otherwise. */
export const DEFAULT_DIRECT_FALLBACK: VideoDirectFallback = 'ultrafast';

export function parseDirectFallback(value: unknown): VideoDirectFallback | null {
  return typeof value === 'string' && (DIRECT_FALLBACKS as readonly string[]).includes(value)
    ? (value as VideoDirectFallback)
    : null;
}

/** How nice ffmpeg is to the rest of the host: Normal leaves it alone, Low and Lowest lower its priority. */
export const CPU_PRIORITIES: readonly VideoCpuPriority[] = ['normal', 'low', 'lowest'];
export const DEFAULT_CPU_PRIORITY: VideoCpuPriority = 'normal';

export function parseCpuPriority(value: unknown): VideoCpuPriority | null {
  return typeof value === 'string' && (CPU_PRIORITIES as readonly string[]).includes(value)
    ? (value as VideoCpuPriority)
    : null;
}

/** Most encode threads the setting accepts; 0 means the sidecar works the number out. */
export const MAX_ENCODE_THREADS = 64;

/** Direct-stream packet pacing: 2.5 times the video's own bitrate unless the admin changes it. */
export const DEFAULT_DIRECT_PACING = 2.5;
export const MAX_DIRECT_PACING = 10;

/** 0 (off) or a multiple from 1 to 10, one decimal; anything else is not a pacing value. */
export function parseDirectPacing(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 0;
  if (n < 1 || n > MAX_DIRECT_PACING) return null;
  return Math.round(n * 10) / 10;
}

export const VIDEO_STREAMING_SETTING_KEYS = [
  VIDEO_NO_VIEWER_TIMEOUT_KEY,
  VIDEO_ANNOUNCE_AUTO_STOPS_KEY,
  VIDEO_AUTO_MAX_PRESET_KEY,
  VIDEO_DEFAULT_ENCODER_KEY,
  VIDEO_PREFER_HARDWARE_KEY,
  VIDEO_MAX_BITRATE_KEY,
  VIDEO_ENCODE_PROFILE_KEY,
  VIDEO_CPU_USED_KEY,
  VIDEO_ENCODE_THREADS_KEY,
  VIDEO_CONVERT_THREADS_KEY,
  VIDEO_CPU_PRIORITY_KEY,
  VIDEO_DIRECT_PACING_KEY,
  VIDEO_DIRECT_FALLBACK_KEY,
  VIDEO_PRESET_BITRATES_KEY,
] as const;

/** Longest accepted no-viewer timeout (24 h). */
export const MAX_NO_VIEWER_TIMEOUT_SEC = 86_400;
/** Highest accepted bitrate clamp (100 Mbps). */
export const MAX_BITRATE_CLAMP_KBPS = 100_000;

/** Parse a non-negative integer within [0, max]; null when invalid. */
export function parseBoundedInt(raw: unknown, max: number): number | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n <= max ? n : null;
}

function parseBool(raw: string | undefined): boolean | null {
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return null;
}

/**
 * Environment defaults, used when no admin value is stored:
 * VIDEO_NO_VIEWER_TIMEOUT_SECONDS, VIDEO_AUTO_MAX_PRESET, VIDEO_ENCODER,
 * VIDEO_PREFER_HARDWARE, VIDEO_MAX_BITRATE_KBPS, VIDEO_ENCODE_PROFILE, VIDEO_CPU_USED.
 * When encode knobs are unset, Balanced profile values apply.
 */
export function videoStreamingDefaults(env: NodeJS.ProcessEnv = process.env): VideoStreamSettings {
  const balanced = ENCODE_PROFILE_PRESETS[DEFAULT_ENCODE_PROFILE];
  const autoMax = env.VIDEO_AUTO_MAX_PRESET;
  const profileRaw = env.VIDEO_ENCODE_PROFILE;
  const namedFromEnv = isNamedEncodeProfile(profileRaw) ? profileRaw : null;
  const fromNamed = namedFromEnv ? applyEncodeProfile(namedFromEnv) : null;
  const cpuUsed =
    parseBoundedInt(env.VIDEO_CPU_USED, MAX_CPU_USED) ?? fromNamed?.cpuUsed ?? balanced.cpuUsed;
  const maxBitrateKbps =
    parseBoundedInt(env.VIDEO_MAX_BITRATE_KBPS, MAX_BITRATE_CLAMP_KBPS)
    ?? fromNamed?.maxBitrateKbps
    ?? balanced.maxBitrateKbps;
  const autoMaxPreset: VideoStreamPresetKey = isPresetKey(autoMax)
    ? autoMax
    : (fromNamed?.autoMaxPreset ?? (isPresetKey(DEFAULT_AUTO_MAX_PRESET) ? DEFAULT_AUTO_MAX_PRESET : balanced.autoMaxPreset));
  const encodeProfile: VideoEncodeProfile = isEncodeProfile(profileRaw)
    ? profileRaw
    : inferEncodeProfile({ autoMaxPreset, maxBitrateKbps, cpuUsed });
  return {
    noViewerTimeoutSec: parseBoundedInt(env.VIDEO_NO_VIEWER_TIMEOUT_SECONDS, MAX_NO_VIEWER_TIMEOUT_SEC) ?? 300,
    announceAutoStops: true,
    autoMaxPreset,
    defaultEncoder: normalizeEncoderRequest(env.VIDEO_ENCODER, 'auto'),
    preferHardware: parseBool(env.VIDEO_PREFER_HARDWARE) ?? false,
    maxBitrateKbps,
    encodeProfile,
    cpuUsed: Math.max(MIN_CPU_USED, cpuUsed),
    encodeThreads: 0,
    convertThreads: 0,
    cpuPriority: DEFAULT_CPU_PRIORITY,
    directPacing: DEFAULT_DIRECT_PACING,
    directFallback: DEFAULT_DIRECT_FALLBACK,
    presetBitrates: defaultPresetBitrates(),
  };
}

/** Merge stored admin values over env defaults; invalid stored values are ignored. */
export function parseVideoStreamingSettings(
  stored: Map<string, string>,
  defaults: VideoStreamSettings = videoStreamingDefaults(),
): VideoStreamSettings {
  const autoMax = stored.get(VIDEO_AUTO_MAX_PRESET_KEY);
  const autoMaxPreset = isPresetKey(autoMax) ? (autoMax as VideoStreamPresetKey) : defaults.autoMaxPreset;
  const maxBitrateKbps =
    parseBoundedInt(stored.get(VIDEO_MAX_BITRATE_KEY), MAX_BITRATE_CLAMP_KBPS) ?? defaults.maxBitrateKbps;
  const cpuUsed =
    parseBoundedInt(stored.get(VIDEO_CPU_USED_KEY), MAX_CPU_USED) ?? defaults.cpuUsed;
  const inferred = inferEncodeProfile({ autoMaxPreset, maxBitrateKbps, cpuUsed });
  const storedProfile = stored.get(VIDEO_ENCODE_PROFILE_KEY);
  let encodeProfile: VideoEncodeProfile = inferred;
  if (storedProfile === 'custom') encodeProfile = 'custom';
  else if (isNamedEncodeProfile(storedProfile)) {
    encodeProfile = inferred === storedProfile ? storedProfile : inferred;
  }
  return {
    noViewerTimeoutSec:
      parseBoundedInt(stored.get(VIDEO_NO_VIEWER_TIMEOUT_KEY), MAX_NO_VIEWER_TIMEOUT_SEC) ?? defaults.noViewerTimeoutSec,
    announceAutoStops: parseBool(stored.get(VIDEO_ANNOUNCE_AUTO_STOPS_KEY)) ?? defaults.announceAutoStops,
    autoMaxPreset,
    defaultEncoder: normalizeEncoderRequest(stored.get(VIDEO_DEFAULT_ENCODER_KEY), defaults.defaultEncoder),
    preferHardware: parseBool(stored.get(VIDEO_PREFER_HARDWARE_KEY)) ?? defaults.preferHardware,
    maxBitrateKbps,
    encodeProfile,
    cpuUsed,
    encodeThreads: parseBoundedInt(stored.get(VIDEO_ENCODE_THREADS_KEY), MAX_ENCODE_THREADS) ?? defaults.encodeThreads,
    convertThreads: parseBoundedInt(stored.get(VIDEO_CONVERT_THREADS_KEY), MAX_ENCODE_THREADS) ?? defaults.convertThreads,
    cpuPriority: parseCpuPriority(stored.get(VIDEO_CPU_PRIORITY_KEY)) ?? defaults.cpuPriority,
    directPacing: parseDirectPacing(stored.get(VIDEO_DIRECT_PACING_KEY)) ?? defaults.directPacing,
    directFallback: parseDirectFallback(stored.get(VIDEO_DIRECT_FALLBACK_KEY)) ?? defaults.directFallback,
    presetBitrates: { ...defaults.presetBitrates, ...parsePresetBitratesLenient(stored.get(VIDEO_PRESET_BITRATES_KEY)) },
  };
}

/** App setting holding one server's overrides as JSON (same field names as VideoStreamSettings). */
export function videoServerOverridesKey(serverConfigId: number): string {
  return `video_streaming_server:${serverConfigId}`;
}

/** Validate stored/submitted overrides; invalid fields are dropped. */
export function parseServerOverrides(raw: unknown): Partial<VideoStreamSettings> {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object') return {};
  // Validate fields one-by-one (ignore profile side effects), then normalize together
  // so a complete named profile stays named instead of collapsing to custom.
  const accepted: Record<string, unknown> = {};
  for (const field of [
    'noViewerTimeoutSec', 'announceAutoStops', 'autoMaxPreset', 'defaultEncoder', 'preferHardware',
    'maxBitrateKbps', 'encodeProfile', 'cpuUsed', 'encodeThreads', 'convertThreads', 'cpuPriority', 'directPacing', 'directFallback', 'presetBitrates',
  ] as const) {
    const value = (obj as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (!parseVideoStreamingUpdate({ [field]: value }).ok) continue;
    accepted[field] = value;
  }
  if (Object.keys(accepted).length === 0) return {};
  const check = parseVideoStreamingUpdate(accepted);
  if (!check.ok) return {};
  const out: Partial<VideoStreamSettings> = {};
  for (const row of check.rows) {
    if (row.key === VIDEO_NO_VIEWER_TIMEOUT_KEY) out.noViewerTimeoutSec = Number(row.value);
    else if (row.key === VIDEO_ANNOUNCE_AUTO_STOPS_KEY) out.announceAutoStops = row.value === 'true';
    else if (row.key === VIDEO_AUTO_MAX_PRESET_KEY) out.autoMaxPreset = row.value as VideoStreamPresetKey;
    else if (row.key === VIDEO_DEFAULT_ENCODER_KEY) {
      out.defaultEncoder = row.value as VideoStreamSettings['defaultEncoder'];
    } else if (row.key === VIDEO_PREFER_HARDWARE_KEY) out.preferHardware = row.value === 'true';
    else if (row.key === VIDEO_MAX_BITRATE_KEY) out.maxBitrateKbps = Number(row.value);
    else if (row.key === VIDEO_ENCODE_PROFILE_KEY) out.encodeProfile = row.value as VideoEncodeProfile;
    else if (row.key === VIDEO_CPU_USED_KEY) out.cpuUsed = Number(row.value);
    else if (row.key === VIDEO_ENCODE_THREADS_KEY) out.encodeThreads = Number(row.value);
    else if (row.key === VIDEO_CONVERT_THREADS_KEY) out.convertThreads = Number(row.value);
    else if (row.key === VIDEO_CPU_PRIORITY_KEY) out.cpuPriority = row.value as VideoCpuPriority;
    else if (row.key === VIDEO_DIRECT_PACING_KEY) out.directPacing = Number(row.value);
    else if (row.key === VIDEO_DIRECT_FALLBACK_KEY) out.directFallback = row.value as VideoDirectFallback;
    else if (row.key === VIDEO_PRESET_BITRATES_KEY) out.presetBitrates = JSON.parse(row.value) as PresetBitrates;
  }
  return out;
}

/** What one bot can override: absent = inherit the server, then the global, value. */
export interface BotResourceOverrides {
  encodeThreads?: number;
  convertThreads?: number;
  cpuPriority?: VideoCpuPriority;
}

/** App setting holding one bot's thread overrides as JSON. */
export function videoBotOverridesKey(botId: number): string {
  return `video_streaming_bot:${botId}`;
}

/** Validate stored overrides; an invalid field is dropped (inherits). */
export function parseBotResourceOverrides(raw: unknown): BotResourceOverrides {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object') return {};
  const out: BotResourceOverrides = {};
  const enc = parseBoundedInt((obj as Record<string, unknown>).encodeThreads, MAX_ENCODE_THREADS);
  if (enc != null) out.encodeThreads = enc;
  const conv = parseBoundedInt((obj as Record<string, unknown>).convertThreads, MAX_ENCODE_THREADS);
  if (conv != null) out.convertThreads = conv;
  const prio = parseCpuPriority((obj as Record<string, unknown>).cpuPriority);
  if (prio != null) out.cpuPriority = prio;
  return out;
}

export type BotResourceUpdate =
  | { ok: true; overrides: BotResourceOverrides }
  | { ok: false; error: string };

/**
 * Apply a PUT body to the stored overrides: a number from 0 to 64 (threads) or a priority sets a
 * field, null removes it (inherit), an absent field is left as it was.
 */
export function applyBotResourceUpdate(current: BotResourceOverrides, body: Record<string, unknown> | null | undefined): BotResourceUpdate {
  const b = body ?? {};
  const next: BotResourceOverrides = { ...current };
  let supplied = 0;
  for (const field of ['encodeThreads', 'convertThreads'] as const) {
    const value = b[field];
    if (value === undefined) continue;
    supplied++;
    if (value === null) {
      delete next[field];
      continue;
    }
    const n = parseBoundedInt(value, MAX_ENCODE_THREADS);
    if (n == null) return { ok: false, error: `${field} must be 0–${MAX_ENCODE_THREADS} (0 = automatic) or null to inherit` };
    next[field] = n;
  }
  const prio = b.cpuPriority;
  if (prio !== undefined) {
    supplied++;
    if (prio === null) delete next.cpuPriority;
    else {
      const v = parseCpuPriority(prio);
      if (v == null) return { ok: false, error: `cpuPriority must be ${CPU_PRIORITIES.join(', ')} or null to inherit` };
      next.cpuPriority = v;
    }
  }
  if (supplied === 0) return { ok: false, error: 'No resource settings supplied' };
  return { ok: true, overrides: next };
}

export async function loadVideoStreamingSettings(
  prisma: PrismaClient,
  serverConfigId?: number,
  botId?: number,
): Promise<VideoStreamSettings> {
  const keys: string[] = [...VIDEO_STREAMING_SETTING_KEYS];
  if (serverConfigId != null) keys.push(videoServerOverridesKey(serverConfigId));
  if (botId != null) keys.push(videoBotOverridesKey(botId));
  const rows = await prisma.appSetting.findMany({ where: { key: { in: keys } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  let settings = parseVideoStreamingSettings(map);
  if (serverConfigId != null) {
    settings = mergeVideoSettings(settings, parseServerOverrides(map.get(videoServerOverridesKey(serverConfigId))));
  }
  if (botId != null) {
    settings = mergeVideoSettings(settings, parseBotResourceOverrides(map.get(videoBotOverridesKey(botId))));
  }
  return settings;
}

/** One bot's stored overrides, and the values it gets from them and the levels above. */
export async function loadBotResourceSettings(prisma: PrismaClient, serverConfigId: number, botId: number) {
  const row = await prisma.appSetting.findUnique({ where: { key: videoBotOverridesKey(botId) } });
  const overrides = parseBotResourceOverrides(row?.value);
  const effective = await loadVideoStreamingSettings(prisma, serverConfigId, botId);
  return {
    overrides,
    effective: {
      encodeThreads: effective.encodeThreads,
      convertThreads: effective.convertThreads,
      cpuPriority: effective.cpuPriority,
    },
  };
}

/** Global defaults, one server's overrides, and the merged result. */
export async function loadServerVideoStreamingSettings(prisma: PrismaClient, serverConfigId: number) {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [...VIDEO_STREAMING_SETTING_KEYS, videoServerOverridesKey(serverConfigId)] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const global = parseVideoStreamingSettings(map);
  const overrides = parseServerOverrides(map.get(videoServerOverridesKey(serverConfigId)));
  return { global, overrides, effective: mergeVideoSettings(global, overrides) };
}

export type VideoStreamingUpdate =
  | { ok: true; rows: Array<{ key: string; value: string }> }
  | { ok: false; error: string };

/** Validate a PUT body into setting rows; only supplied fields are updated. */
export function parseVideoStreamingUpdate(body: Record<string, unknown> | null | undefined): VideoStreamingUpdate {
  const b = body ?? {};
  const rows: Array<{ key: string; value: string }> = [];

  // Named encode profile expands to Auto max + bitrate + cpu-used.
  if (b.encodeProfile !== undefined) {
    if (!isEncodeProfile(b.encodeProfile)) {
      return { ok: false, error: 'encodeProfile must be performance, balanced, quality or custom' };
    }
    if (isNamedEncodeProfile(b.encodeProfile)) {
      const applied = applyEncodeProfile(b.encodeProfile);
      rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: applied.encodeProfile });
      rows.push({ key: VIDEO_AUTO_MAX_PRESET_KEY, value: applied.autoMaxPreset });
      rows.push({ key: VIDEO_MAX_BITRATE_KEY, value: String(applied.maxBitrateKbps) });
      rows.push({ key: VIDEO_CPU_USED_KEY, value: String(applied.cpuUsed) });
    } else {
      rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: 'custom' });
    }
  }

  if (b.noViewerTimeoutSec !== undefined) {
    const n = parseBoundedInt(b.noViewerTimeoutSec, MAX_NO_VIEWER_TIMEOUT_SEC);
    if (n == null) return { ok: false, error: `noViewerTimeoutSec must be 0–${MAX_NO_VIEWER_TIMEOUT_SEC} seconds (0 = off)` };
    rows.push({ key: VIDEO_NO_VIEWER_TIMEOUT_KEY, value: String(n) });
  }
  if (b.announceAutoStops !== undefined) {
    if (typeof b.announceAutoStops !== 'boolean') return { ok: false, error: 'announceAutoStops must be a boolean' };
    rows.push({ key: VIDEO_ANNOUNCE_AUTO_STOPS_KEY, value: b.announceAutoStops ? 'true' : 'false' });
  }
  if (b.autoMaxPreset !== undefined) {
    if (!isPresetKey(b.autoMaxPreset)) return { ok: false, error: 'autoMaxPreset must be 480p, 720p, 1080p, 1440p or 2160p' };
    rows.push({ key: VIDEO_AUTO_MAX_PRESET_KEY, value: b.autoMaxPreset });
    if (b.encodeProfile === undefined) rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: 'custom' });
  }
  if (b.defaultEncoder !== undefined) {
    if (b.defaultEncoder !== 'auto' && !isEncoderId(b.defaultEncoder)) {
      return { ok: false, error: 'defaultEncoder must be auto or a known encoder id' };
    }
    rows.push({ key: VIDEO_DEFAULT_ENCODER_KEY, value: String(b.defaultEncoder) });
  }
  if (b.preferHardware !== undefined) {
    if (typeof b.preferHardware !== 'boolean') return { ok: false, error: 'preferHardware must be a boolean' };
    rows.push({ key: VIDEO_PREFER_HARDWARE_KEY, value: b.preferHardware ? 'true' : 'false' });
  }
  if (b.maxBitrateKbps !== undefined) {
    const n = parseBoundedInt(b.maxBitrateKbps, MAX_BITRATE_CLAMP_KBPS);
    if (n == null) return { ok: false, error: `maxBitrateKbps must be 0–${MAX_BITRATE_CLAMP_KBPS} (0 = no clamp)` };
    rows.push({ key: VIDEO_MAX_BITRATE_KEY, value: String(n) });
    if (b.encodeProfile === undefined) rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: 'custom' });
  }
  if (b.cpuUsed !== undefined) {
    const n = parseBoundedInt(b.cpuUsed, MAX_CPU_USED);
    if (n == null) return { ok: false, error: `cpuUsed must be ${MIN_CPU_USED}–${MAX_CPU_USED}` };
    rows.push({ key: VIDEO_CPU_USED_KEY, value: String(n) });
    if (b.encodeProfile === undefined) rows.push({ key: VIDEO_ENCODE_PROFILE_KEY, value: 'custom' });
  }

  if (b.encodeThreads !== undefined) {
    const n = parseBoundedInt(b.encodeThreads, MAX_ENCODE_THREADS);
    if (n == null) return { ok: false, error: `encodeThreads must be 0–${MAX_ENCODE_THREADS} (0 = automatic)` };
    rows.push({ key: VIDEO_ENCODE_THREADS_KEY, value: String(n) });
  }
  if (b.convertThreads !== undefined) {
    const n = parseBoundedInt(b.convertThreads, MAX_ENCODE_THREADS);
    if (n == null) return { ok: false, error: `convertThreads must be 0–${MAX_ENCODE_THREADS} (0 = automatic)` };
    rows.push({ key: VIDEO_CONVERT_THREADS_KEY, value: String(n) });
  }
  if (b.cpuPriority !== undefined) {
    const v = parseCpuPriority(b.cpuPriority);
    if (v == null) return { ok: false, error: `cpuPriority must be ${CPU_PRIORITIES.join(', ')}` };
    rows.push({ key: VIDEO_CPU_PRIORITY_KEY, value: v });
  }

  if (b.directPacing !== undefined) {
    const n = parseDirectPacing(b.directPacing);
    if (n == null) return { ok: false, error: `directPacing must be 0 (off) or a number from 1 to ${MAX_DIRECT_PACING}` };
    rows.push({ key: VIDEO_DIRECT_PACING_KEY, value: String(n) });
  }

  if (b.directFallback !== undefined) {
    const v = parseDirectFallback(b.directFallback);
    if (v == null) return { ok: false, error: `directFallback must be ${DIRECT_FALLBACKS.join(', ')}` };
    rows.push({ key: VIDEO_DIRECT_FALLBACK_KEY, value: v });
  }

  if (b.presetBitrates !== undefined) {
    const parsed = parsePresetBitratesStrict(b.presetBitrates);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    rows.push({ key: VIDEO_PRESET_BITRATES_KEY, value: JSON.stringify(parsed.value) });
  }

  if (rows.length === 0) return { ok: false, error: 'No video streaming settings supplied' };
  // Last write wins per key when profile expand + field overlap.
  const byKey = new Map<string, string>();
  for (const row of rows) byKey.set(row.key, row.value);
  return { ok: true, rows: [...byKey.entries()].map(([key, value]) => ({ key, value })) };
}

// --- IPTV sources on the local network ---------------------------------------

export const IPTV_LOCAL_HOSTS_KEY = 'iptv_allowed_local_hosts';
export const MAX_IPTV_LOCAL_HOSTS = 32;

/**
 * Operator-approved LAN hosts for IPTV playlists and channels (IPs, CIDRs or
 * hostnames). Invalid stored entries are dropped rather than trusted.
 */
export async function loadIptvLocalHosts(prisma: PrismaClient): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: IPTV_LOCAL_HOSTS_KEY } });
  if (!row?.value) return [];
  try {
    const value: unknown = JSON.parse(row.value);
    if (!Array.isArray(value)) return [];
    const entries = value.filter((v): v is string => typeof v === 'string');
    const { invalid } = parseLocalHostAllowlist(entries);
    return entries.filter((e) => !invalid.includes(e)).slice(0, MAX_IPTV_LOCAL_HOSTS);
  } catch {
    return [];
  }
}

export type IptvLocalHostsUpdate = { ok: true; value: string[] } | { ok: false; error: string };

export function parseIptvLocalHostsUpdate(body: Record<string, unknown> | null | undefined): IptvLocalHostsUpdate {
  const raw = body?.allowedLocalHosts;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    return { ok: false, error: 'allowedLocalHosts must be a list of hosts' };
  }
  const entries = [...new Set((raw as string[]).map((v) => v.trim().toLowerCase()).filter(Boolean))];
  if (entries.length > MAX_IPTV_LOCAL_HOSTS) {
    return { ok: false, error: `At most ${MAX_IPTV_LOCAL_HOSTS} hosts` };
  }
  if (entries.some((e) => e.length > 255)) {
    return { ok: false, error: 'Host entries are limited to 255 characters' };
  }
  const { invalid } = parseLocalHostAllowlist(entries);
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Not allowed: ${invalid.join(', ')}. Use a LAN IP (192.168.1.20), a range (192.168.1.0/24) or a hostname; `
        + 'loopback, link-local and cloud metadata addresses stay blocked.',
    };
  }
  return { ok: true, value: entries };
}

/**
 * Public address of this manager as TeamSpeak clients reach it (scheme, host,
 * optional port and path prefix). Hosted channel banner links are built from it.
 */
export const PUBLIC_URL_KEY = 'public_url';
export const MAX_PUBLIC_URL_LENGTH = 512;

export type PublicUrlUpdate = { ok: true; value: string | null } | { ok: false; error: string };

/** Normalise an operator-supplied public URL; empty clears it. */
export function parsePublicUrl(raw: unknown): PublicUrlUpdate {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'publicUrl must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length > MAX_PUBLIC_URL_LENGTH) return { ok: false, error: `publicUrl is limited to ${MAX_PUBLIC_URL_LENGTH} characters` };
  let url: URL;
  try { url = new URL(trimmed); } catch { return { ok: false, error: 'publicUrl must be a full http:// or https:// address' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'publicUrl must use http:// or https://' };
  if (url.username || url.password) return { ok: false, error: 'publicUrl must not contain credentials' };
  if (url.search || url.hash) return { ok: false, error: 'publicUrl must not contain a query or fragment' };
  return { ok: true, value: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** Saved setting first, then the PUBLIC_URL environment variable; null when neither is valid. */
export async function loadPublicUrl(prisma: PrismaClient): Promise<{ publicUrl: string | null; source: 'setting' | 'env' | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: PUBLIC_URL_KEY } });
  const saved = parsePublicUrl(row?.value);
  if (saved.ok && saved.value) return { publicUrl: saved.value, source: 'setting' };
  const env = parsePublicUrl(process.env.PUBLIC_URL);
  if (env.ok && env.value) return { publicUrl: env.value, source: 'env' };
  return { publicUrl: null, source: null };
}
