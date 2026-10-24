/** Saved encode threads, convert threads and CPU priority for one bot. Empty inherits the server's. */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { VideoCpuPriority } from '@ts6/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useBotVideoResources, useUpdateBotVideoResources } from '@/hooks/use-music-bots';
import { apiErrorMessage } from '@/lib/api-error';
import {
  CPU_PRIORITY_OPTIONS, MAX_VIDEO_THREADS, cpuPriorityLabel, inheritPriorityLabel, inheritThreadsLabel, isCpuPriority,
  parseThreadsInput, sanitizeThreadsInput, threadsLabel, threadsToInput,
} from '@/lib/video-resources';

export function BotVideoResourcesDialog({ botId, botName, open, onOpenChange }: {
  botId: number;
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const resources = useBotVideoResources(botId, open);
  const update = useUpdateBotVideoResources(botId);
  const [encode, setEncode] = useState('');
  const [convert, setConvert] = useState('');
  const [priority, setPriority] = useState<VideoCpuPriority | ''>('');

  // Start from the saved values each time the dialog opens or they change.
  useEffect(() => {
    if (!open || !resources.data) return;
    const saved = resources.data.overrides;
    setEncode(threadsToInput(saved.encodeThreads));
    setConvert(threadsToInput(saved.convertThreads));
    setPriority(saved.cpuPriority ?? '');
  }, [open, resources.data]);

  const data = resources.data;
  const dirty = !!data && (
    parseThreadsInput(encode) !== (data.overrides.encodeThreads ?? null)
    || parseThreadsInput(convert) !== (data.overrides.convertThreads ?? null)
    || (priority || null) !== (data.overrides.cpuPriority ?? null)
  );

  const save = () => {
    update.mutate(
      {
        encodeThreads: parseThreadsInput(encode),
        convertThreads: parseThreadsInput(convert),
        cpuPriority: priority === '' ? null : priority,
      },
      {
        onSuccess: () => {
          toast.success(`CPU settings saved for ${botName}. They apply to its next stream`);
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, 'Failed to save the CPU settings')),
      },
    );
  };

  // Absent until the backend reports what the next stream uses.
  const now = data?.effective.encodeThreads != null ? data.effective : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Video CPU settings: {botName}</DialogTitle>
          <DialogDescription className="text-xs">
            How many CPU threads this bot's streams use and how they rank against other work on the host. Leave a
            field empty to inherit the server's setting. Threads: 0 is automatic, or 1 to {MAX_VIDEO_THREADS}. A single
            start can still override all three in Video options.
          </DialogDescription>
        </DialogHeader>
        {resources.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {resources.isError && (
          <div className="space-y-2">
            <p role="alert" className="text-xs text-destructive">{apiErrorMessage(resources.error, 'Could not load the CPU settings.')}</p>
            <Button size="sm" variant="outline" onClick={() => { void resources.refetch(); }} disabled={resources.isFetching}>Try again</Button>
          </div>
        )}
        {data && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="bot-encode-threads">Encode threads</Label>
              <Input id="bot-encode-threads" inputMode="numeric" autoComplete="off"
                placeholder={inheritThreadsLabel(now?.encodeThreads)} value={encode}
                onChange={(e) => setEncode(sanitizeThreadsInput(e.target.value))} />
              <p className="text-xs text-muted-foreground">Software VP8/VP9 encoding.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bot-convert-threads">Convert threads</Label>
              <Input id="bot-convert-threads" inputMode="numeric" autoComplete="off"
                placeholder={inheritThreadsLabel(now?.convertThreads)} value={convert}
                onChange={(e) => setConvert(sanitizeThreadsInput(e.target.value))} />
              <p className="text-xs text-muted-foreground">The convert-first conversion of a direct stream.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bot-cpu-priority">CPU priority</Label>
              <select id="bot-cpu-priority" className="h-10 w-full rounded-md border bg-background px-2 text-sm"
                value={priority} onChange={(e) => setPriority(isCpuPriority(e.target.value) ? e.target.value : '')}>
                <option value="">{inheritPriorityLabel(now?.cpuPriority)}</option>
                {CPU_PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}: {o.hint}</option>)}
              </select>
            </div>
            {now && (
              <p className="text-xs text-muted-foreground">
                Its next stream uses: encode {threadsLabel(now.encodeThreads ?? 0)}, convert {threadsLabel(now.convertThreads ?? 0)}
                {now.cpuPriority ? `, ${cpuPriorityLabel(now.cpuPriority).toLowerCase()} priority` : ''}.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={!data || !dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
