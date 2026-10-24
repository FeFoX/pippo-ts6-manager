import type { VideoStreamSettings } from '@ts6/common';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ChevronDown } from 'lucide-react';
import {
  ENCODER_OPTIONS, NO_VIEWER_TIMEOUT_OPTIONS, QUALITY_OPTIONS, SOURCE_MODE_OPTIONS,
  autoEncoderPreferenceHint, autoEncoderPreferenceLabel, qualityOptionLabel,
} from '@/lib/video-streaming';
import {
  CPU_PRIORITY_OPTIONS, MAX_VIDEO_THREADS, inheritPriorityLabel, inheritThreadsLabel, isCpuPriority, sanitizeThreadsInput,
  type VideoResources,
} from '@/lib/video-resources';
import { noViewerTimeoutLabel, videoOptionsSummary, type VideoStartOptions } from '@/lib/video-options';

/**
 * Quality, encoder, no-viewer stop and source type for one console start,
 * folded behind a "Video options" row that shows the current choices. They
 * inherit the bot and server defaults; nothing is saved.
 */
export function VideoOptions({ value, onChange, defaults, resourceDefaults }: {
  value: VideoStartOptions;
  onChange(v: VideoStartOptions): void;
  defaults?: VideoStreamSettings;
  /** What empty CPU fields inherit for this bot (its saved values, else the server's). */
  resourceDefaults?: VideoResources;
}) {
  const field = 'h-10 w-full rounded-md border bg-background px-2 text-sm';
  // Preserve any explicit custom timeout alongside the default choice.
  const timeoutOptions = value.noViewerTimeout === '' || NO_VIEWER_TIMEOUT_OPTIONS.some((o) => o.value === value.noViewerTimeout)
    ? NO_VIEWER_TIMEOUT_OPTIONS
    : [{ value: value.noViewerTimeout, label: noViewerTimeoutLabel(value.noViewerTimeout) }, ...NO_VIEWER_TIMEOUT_OPTIONS];
  const serverEncoderLabel = !defaults
    ? null
    : defaults.defaultEncoder === 'auto'
      ? autoEncoderPreferenceLabel(defaults.preferHardware)
      : (ENCODER_OPTIONS.find((o) => o.value === defaults.defaultEncoder)?.label ?? defaults.defaultEncoder);
  return (
    <details className="group rounded-md border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-sm [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 font-medium">Video options</span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{videoOptionsSummary(value)}</span>
          <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div className="space-y-3 border-t p-3">
        <p className="text-xs text-muted-foreground">For this start only. Use defaults to inherit the bot's quality and this server's streaming settings.</p>
        <div className="space-y-1">
          <Label htmlFor="vo-direct">Streaming mode</Label>
          <select id="vo-direct" className={field} value={value.direct ? 'direct' : 'reencode'}
            onChange={(e) => onChange({ ...value, direct: e.target.value === 'direct' })}>
            <option value="reencode">Re-encode (default)</option>
            <option value="direct">Direct: no re-encoding</option>
          </select>
          <p className="text-xs text-muted-foreground">
            {value.direct
              ? 'The video is sent as it is: almost no CPU, but more bandwidth per viewer and a new viewer may wait a few seconds for the next keyframe. It works on a downloaded VP9 file, or an H.264 file without B-frames (YouTube videos are asked for VP9 first); anything else is re-encoded and the Now playing card says why. Quality then only limits the download size.'
              : 'The video is re-encoded to the quality and encoder below.'}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="vo-quality">Quality</Label>
            <select id="vo-quality" className={field} value={value.quality}
              onChange={(e) => onChange({ ...value, quality: e.target.value as VideoStartOptions['quality'] })}>
              <option value="">Use bot default</option>
              {QUALITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{qualityOptionLabel(o, defaults?.presetBitrates)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-encoder">Encoder</Label>
            <select id="vo-encoder" className={field} value={value.encoder}
              onChange={(e) => onChange({ ...value, encoder: e.target.value as VideoStartOptions['encoder'] })}>
              <option value="">Use server default{serverEncoderLabel ? ` (${serverEncoderLabel})` : ''}</option>
              {ENCODER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === 'auto' && defaults
                    ? autoEncoderPreferenceLabel(defaults.preferHardware)
                    : o.label}
                </option>
              ))}
            </select>
            {defaults && (
              <p className="text-xs text-muted-foreground">{autoEncoderPreferenceHint(defaults.preferHardware)}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-noviewer">Stop with no viewers after</Label>
            <select id="vo-noviewer" className={field} value={value.noViewerTimeout}
              onChange={(e) => onChange({ ...value, noViewerTimeout: e.target.value })}>
              <option value="">Use server default{defaults ? ` (${noViewerTimeoutLabel(String(defaults.noViewerTimeoutSec))})` : ''}</option>
              {timeoutOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-source">Source type</Label>
            <select id="vo-source" className={field} value={value.sourceMode}
              onChange={(e) => onChange({ ...value, sourceMode: e.target.value as VideoStartOptions['sourceMode'] })}>
              {SOURCE_MODE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-encode-threads">Encode threads</Label>
            <Input id="vo-encode-threads" className="h-10" inputMode="numeric" autoComplete="off"
              placeholder={inheritThreadsLabel(resourceDefaults?.encodeThreads ?? defaults?.encodeThreads)}
              value={value.encodeThreads}
              onChange={(e) => onChange({ ...value, encodeThreads: sanitizeThreadsInput(e.target.value) })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-convert-threads">Convert threads</Label>
            <Input id="vo-convert-threads" className="h-10" inputMode="numeric" autoComplete="off"
              placeholder={inheritThreadsLabel(resourceDefaults?.convertThreads ?? defaults?.convertThreads)}
              value={value.convertThreads}
              onChange={(e) => onChange({ ...value, convertThreads: sanitizeThreadsInput(e.target.value) })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="vo-cpu-priority">CPU priority</Label>
            <select id="vo-cpu-priority" className={field} value={value.cpuPriority}
              onChange={(e) => onChange({
                ...value, cpuPriority: isCpuPriority(e.target.value) ? e.target.value : '',
              })}>
              <option value="">{inheritPriorityLabel(resourceDefaults?.cpuPriority ?? defaults?.cpuPriority)}</option>
              {CPU_PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}: {o.hint}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Threads: leave empty to inherit, 0 for automatic, or 1 to {MAX_VIDEO_THREADS}. Encode threads apply to a software
          VP8/VP9 encode; convert threads to the convert-first conversion of a direct stream.
        </p>
      </div>
    </details>
  );
}
