# Changes from upstream

This fork follows [uniskela/ts6-manager](https://github.com/uniskela/ts6-manager). It started from v1.10.1 and is now
merged with upstream [v1.11.4](https://github.com/uniskela/ts6-manager/releases/tag/v1.11.4); everything upstream added
up to that release is here too. [Merged with upstream 1.11.4](#merged-with-upstream-1114) lists where the two met.

The new settings live in the database and are edited in the web GUI. The new environment variables are
`VIDEO_CONVERT_THREADS` and `FFMPEG_THREAD_QUEUE_SIZE`. The database schema is the same
as upstream's: each new setting is a key/value row with a built-in default.

[`docs/public/music-bots.md`](docs/public/music-bots.md) and [`docs/public/video-streaming.md`](docs/public/video-streaming.md) cover each
feature in more detail.

## Summary

| Feature | Setting (DB key) | Default | Where in the GUI |
|---|---|---|---|
| Video seek | none | | `!seek`, Now playing card |
| Seek cooldown | `seek_cooldown_seconds` | `120` s (`0` = off) | Settings → YouTube → Download & Stream Limits |
| Resume cooldown | `resume_cooldown_seconds` | `10` s (`0` = off) | Settings → YouTube → Download & Stream Limits |
| Bot access | `bot_control_groups` | empty (everybody) | Settings → Users → Bot access |
| Direct streams | none, chosen per start | Re-encode | Bot console → Link → Video options → Streaming mode |
| Video pause/resume | none | | Now playing card, `!pause` |
| Retransmission (NACK) | none | always on | |
| VP9 descriptor rewrite | none | always on for copied VP9 | |
| Keyframe pacing | `video_direct_pacing` | `2.5` (`0` = off, 1 to 10) | Media Library → Streaming defaults (also per server) |
| Encode threads | `video_encode_threads` | `0` (automatic) | Media Library → Streaming defaults → Advanced (also per server, per bot, per stream) |
| Convert threads | `video_convert_threads` | `0` (automatic) | same places |
| CPU priority | `video_cpu_priority` | `normal` | same places |
| Convert-first fallback | `video_direct_fallback` | `ultrafast` | Media Library → Streaming defaults (also per server) |
| Bitrate per resolution | `video_preset_bitrates` | see below | Media Library → Streaming defaults (also per server) |
| Segment-boundary freeze | `FFMPEG_THREAD_QUEUE_SIZE` (env) | `512` (`0` = FFmpeg's 8) | |
| Command listener race | none | | |

## Chat commands

| Command | Change |
|---|---|
| `!seek <seconds\|+seconds\|-seconds>` | Now also works inside a non-live video, YouTube included. Live streams and radio cannot be seeked. |
| `!pause` | Now also pauses and resumes a finite video. |
| `!streamdirect <url> [preset]` | New. Same as `!stream`, but sends the video without re-encoding when possible. |

## Features

### Video seek

`!seek` now works inside a non-live video as well as a track, and changing the volume keeps the position.

- API: the sidecar's `POST /source` takes the offset in `startAtSecs`, the field upstream 1.11 added for its quality
  restarts, so a later Auto quality change resumes from the seeked position.
- A YouTube video streamed directly can come as an HLS playlist instead of a plain file. ffmpeg cannot jump into
  such a playlist: it fetches every segment from the start and drops them until it reaches the position, so a seek
  froze the picture for as long as that takes (tens of seconds, minutes for a long video). The direct format choice
  now prefers a plain file within each codec, and a seek asks yt-dlp for formats without HLS first, which can be a
  different (lower) resolution than the one playing. When only an HLS format exists, `!seek` is refused with a
  message and the video keeps playing; resuming a paused video goes on from where it paused, with a notice. A volume
  change or an automatic quality step that restarts the video from a later position asks for the same formats, and a
  Bot Flow "Voice Seek" step skips a refused seek instead of failing.
- Files: `packages/backend/src/voice/voice-bot.ts`, `voice/commands/playback.ts`, `voice/streaming/sidecar-client.ts`,
  `voice/streaming/video-download.ts`, `packages/sidecar/main.go`.

### Seek cooldown

Each seek on a remote source (a YouTube track or video, a link, a radio URL) reopens it, so a bot waits this long
between two such seeks, whoever asks. Seeks in a file that is already on the server are never limited.

- Setting `seek_cooldown_seconds`, default `120`, range `0` to `86400`, `0` turns it off.
- API: `PUT /api/settings/limits` accepts `seekCooldownSeconds`. A refused seek answers `429` on
  `POST /api/music-bots/:id/seek` and `/resume`; in chat the user is told how long to wait; a flow's Voice Seek step
  is skipped with a warning.
- Resume cooldown: setting `resume_cooldown_seconds`, default `10`, range `0` to `3600`, `0` turns it off, set in the same card
  or with `resumeCooldownSeconds` on the same endpoint. It only limits resuming a paused video that has no local copy, and a
  refused resume answers `429`.
- Audit: `settings.limits_update`.
- Files: `packages/backend/src/utils/app-settings.ts`, `routes/settings.routes.ts`, `voice/voice-bot-manager.ts`,
  `bot-engine/flow-runner.ts`.

### Bot access control

Only members of the chosen TeamSpeak server groups can use the built-in chat commands (`!play`, `!stop`, `!seek`,
`!help` and the rest, including the cross-channel `!here`, `!come` and `!help`, and upstream's `!remote` and
`!voteskip`). Upstream 1.11's media command permissions (playback, queue and video, per server) still apply on top:
a member of the control group must also be allowed by them.

- Setting `bot_control_groups` (group names or ids). Default empty, which means everybody can use the bot.
- The manager asks TeamSpeak for the sender's groups at every command, so taking a group away works at once. If
  TeamSpeak does not answer, or a listed group does not exist, nobody is allowed (a name or numeric id that matches no
  server group is logged as a warning). Anyone refused gets one short reply every 30 seconds, also for `!here`, `!come`
  and `!help` typed outside the bot's channel, and the command does not run.
- Custom chat commands, watching a video stream and the web panel are not restricted.
- API (new, admin only): `GET /api/settings/bot-access` and `PUT /api/settings/bot-access` with
  `{ "controlGroups": ["..."] }`. Entries are trimmed and de-duplicated without regard to case.
- Audit (new): `settings.bot_access_update`.
- Files: `packages/backend/src/voice/commands/authorization.ts` (new), `voice/commands/routing.ts`,
  `voice/commands/context.ts`, `voice/chat-commands.ts`, `routes/settings.routes.ts`,
  `packages/frontend/src/pages/Settings.tsx`, `api/settings.api.ts`, `pages/AuditHistory.tsx`.

### Direct streams (no re-encoding) and `!streamdirect`

A direct stream sends the video as it is, without decoding and encoding it again, so it uses almost no CPU.

- It can copy VP9 profile 0 (8-bit 4:2:0) and H.264 (8-bit 4:2:0) without B-frames. The picture is checked with one
  short `ffprobe`, a local file directly and a remote URL through the sidecar. AV1, HEVC, 10-bit and H.264 with
  B-frames are not copied (see the convert-first fallback below), and the Now playing card and the chat reply say why.
- When a source delivers the picture and the sound as two downloads (YouTube above 720p, streamed directly), the
  picture is checked and copied as above and the sound, read as a second input, is encoded to Opus. Nothing is
  re-encoded but the audio. The convert-first fallback does not apply to such a source: one that cannot be copied is
  re-encoded while it plays.
- YouTube downloads for a direct stream ask for VP9 first, then H.264, then the usual choice.
- Viewers keep the codec they negotiated for the whole stream; a later source in another codec is re-encoded to it.
- It is chosen for each start, in Video options → Streaming mode → *Direct: no re-encoding* or with
  `!streamdirect`. Nothing is stored, and the default stays Re-encode. `!streamdirect` on a running re-encoded stream asks for `!stopstream` first.
- API: the stream start options accept `direct: true`. Bot status gains `direct`, `directFallback`, `paused` and
  `preparing`. The sidecar's `POST /source` accepts `passthrough`; `POST /probe` accepts `detail: true`.
- Files: `voice/streaming/source-probe.ts`, `voice/streaming/start-options.ts`, `voice/streaming/video-download.ts`,
  `voice/commands/streaming.ts`, `voice/voice-bot.ts`, `packages/common/src/types/music.ts`,
  `packages/sidecar/main.go`, `egress.go`, `encoders.go`, frontend `VideoOptions.tsx`, `LinkSource.tsx`.
- Each viewer gets the file's own bitrate (often 3 to 5 Mbps for 1080p). A viewer who joins late waits for the next
  keyframe, and after a seek or resume playback starts at the keyframe before the requested time. Audio is still
  encoded to Opus.

### Video pause and resume

Pause stops the encode and remembers the position; viewers stay connected and keep the last picture. Resume starts
again from that position (a video without a local copy is reopened; that does not count as a seek, but a resume cooldown of 10 seconds applies between two resumes).
Live streams and looping videos cannot be paused.

- `POST /api/music-bots/:id/pause` and `/resume` now handle video (`409` when the video cannot be paused).
- Files: `voice/voice-bot.ts`, `routes/music-bots.routes.ts`, `voice/commands/playback.ts`,
  frontend `components/media/NowPlaying.tsx`.

### Retransmission of lost packets (NACK)

On every video stream the sidecar now offers NACK and PLI feedback and reads the viewers' RTCP. A lost packet is
sent again, where before the picture froze until the next keyframe.

- The sidecar's `GET /stats` reports `retransmissionRequests` and `keyframeRequests`.
- Files: `packages/sidecar/main.go`, `encoders.go`.

### VP9 packet descriptor

ffmpeg's VP9 RTP packetizer marks every packet with the same one-byte descriptor, so a receiver treats every frame as
a keyframe and cannot recover after a loss. For copied VP9 the sidecar rewrites the descriptor the way libwebrtc's
sender writes it (15-bit picture id, inter-picture bit, layer index, TL0PICIDX, scalability structure on keyframes).
In a test with 2% packet loss, frozen picture went from 10 to 27 s per 40 s down to about 2.5 s.

- Files: `packages/sidecar/vp9_descriptor.go` (new), `main.go`.

### Keyframe pacing

On direct streams the sidecar spreads the packets of each frame over time, at a multiple of the video's measured
bitrate, so a large keyframe does not go out as one burst. A keyframe can arrive up to 0.6 s later, and the audio is
held back by the pacer's recent average delay (smoothed over about 2 s), so the two stay close; a single late keyframe
can still trail the audio by up to 0.6 s.

- Setting `video_direct_pacing`, default `2.5`; `0` = off, otherwise `1` to `10`. GUI choices: Light 4×, Normal 2.5×,
  Strong 1.5×, Off. Also settable per server.
- The sidecar's `POST /source` accepts `pacing`.
- Files: `packages/sidecar/pacer.go` (new), `main.go`, `utils/app-settings.ts`,
  frontend `VideoStreamDefaultsCard.tsx`.

### Encode threads, convert threads and CPU priority

The software VP8 and VP9 encoders were given one thread per CPU the sidecar process could see. A container limited to
3 CPUs on a 6-core host still saw 6, so ffmpeg ran 6 threads inside a 3-CPU budget and was throttled. The default is
now the smaller of the visible CPUs and the container's CPU quota (cgroup v1 or v2).

- Setting `video_encode_threads`: `0` (default) = automatic, otherwise 1 to 64. `VIDEO_ENCODE_THREADS` still applies
  when the setting is `0`. The sidecar's `POST /source` and `POST /convert` accept `threads`.
- Setting `video_convert_threads`: threads of the convert-first x264 conversion. `0` (default) = automatic:
  `VIDEO_CONVERT_THREADS`, else at most 2 (or the encode threads when fewer). A number is used as it is. `POST /convert`
  accepts `convertThreads`.
- Setting `video_cpu_priority`: `normal` (default), `low` (nice 10) or `lowest` (nice 19), applied by the sidecar to
  every ffmpeg it starts (live encode and conversion); not on Windows. `POST /source` and `POST /convert` accept
  `cpuPriority`; `VIDEO_CPU_PRIORITY` is used only when a caller names none.
- Where they are set, highest first: one stream (Video options, or `encodeThreads`/`convertThreads`/`cpuPriority` in the
  stream start body), one bot (`GET/PUT /api/music-bots/:id/video-resources`, stored as the app setting
  `video_streaming_bot:<id>`), one server, then the global setting, then the environment, then automatic. On the first
  three, a missing value inherits and `0` is an explicit "automatic". Bot status reports the values in effect.
- Files: `packages/sidecar/cpu_limit.go` (new), `encoders.go`, `convert.go`, `utils/app-settings.ts`,
  frontend `VideoStreamDefaultsCard.tsx`.

### Convert-first fallback

If a direct stream cannot copy the picture, the manager first converts the whole video to H.264 without B-frames
(x264, a keyframe about every second) and then streams the converted file by copy. The conversion's bitrate cap is the
stream's bitrate, lowered to the source's own video bitrate when the probe reports one, so the file does not come out
larger than its source by more than the audio and container overhead. When the source reports no bitrate, only the
stream's cap applies.

- Setting `video_direct_fallback`: `ultrafast` (default), `superfast`, `veryfast`, or `live` (re-encode while it
  plays, the upstream behaviour). Also settable per server.
- Live sources, videos longer than *Max video duration* (default 15 min), failed conversions and sources that
  cannot be inspected are re-encoded live instead, and the reason is shown. Only one conversion runs at a time.
- Progress, speed and time left are shown on the Now playing card with a Cancel button; `!stopstream` cancels too.
  A start that takes longer than 20 s is answered with HTTP `202` ("still starting").
- Sidecar API (new, authenticated like the rest): `POST /convert`, `GET /convert?id=`, `POST /convert/cancel`.
  The source is read under the sidecar's egress rules. The output `.stream-<digits>.mp4` is written to the music
  folder and deleted when the stream ends. A restart can leave one behind, so at start-up the sidecar removes
  `.stream-<digits>.mp4` and `.stream-<digits>.mp4.part` files in the music folder that are more than four hours old.
- By default the conversion uses at most 2 x264 threads (see Convert threads), so it cannot take the CPUs a live
  stream needs. The manager gives up on a conversion that makes no progress for 5 minutes, or that would take longer
  than twice the video's length (at least 10 minutes), and re-encodes the video live instead.
- Files: `packages/sidecar/convert.go` (new), `voice/streaming/sidecar-client.ts`, `voice/voice-bot.ts`,
  `routes/music-bots.routes.ts`, frontend `NowPlaying.tsx`.

### Bitrate per resolution

Each resolution has its own target bitrate, set in the GUI.

- Setting `video_preset_bitrates`, each value 100 to 9500 kbps; a full map is required when saving. Per-server
  overrides are merged per resolution.
- Built-in values: 480p 1000, 720p 4000, 1080p 7000, 1440p 8000, 2160p 9500 kbps.
- The existing bitrate limit still clamps every stream. Profile limits changed: Performance 4000, Balanced 7000
  (upstream Balanced was 4500). The documented default of `VIDEO_MAX_BITRATE_KBPS` is now 7000.
- Files: `utils/app-settings.ts`, `voice/streaming/quality.ts`, `voice/streaming/encode-profiles.ts`,
  `voice/streaming/types.ts`, frontend `VideoStreamDefaultsCard.tsx`, `lib/encode-profiles.ts`.

### Segment-boundary freeze

With a remote HLS source, FFmpeg paces the output with `-re` and reads each input through a demuxer thread that, by
default, may be only eight packets ahead. At every segment boundary the HLS demuxer reloads the playlist and fetches
the next segment over a new connection (the sidecar sends `Connection: close`), which takes a few hundred
milliseconds over a slow link. With a queue that shallow the paced output waits for it, so every destination freezes
briefly once per segment.

Remote inputs now get `-thread_queue_size 512`, so the demuxers read seconds ahead and the fetch overlaps with
playout. The option is added to FFmpeg's playback arguments only: ffprobe does not accept it, so it is not part of
the arguments shared with `FFMPEG_EXTRA_INPUT_ARGS`. Set `FFMPEG_THREAD_QUEUE_SIZE=0` to use FFmpeg's default again.
A deeper queue costs memory only while a stream runs (at most 512 compressed packets per input).

### Command listener race (bot flows)

A flow whose command trigger names a channel needs its own SSH command listener in that channel.

- Two concurrent calls could open two listeners for the same channel, so a chat command ran its flow twice.
  Listeners being set up are now tracked.
- The music bots' startup cleanup closed every command listener on the server when no music bot had command
  channels set, including the flows' listeners, and nothing reopened them: the flow stopped answering until it was
  disabled and enabled again. Each listener now records who opened it (a flow or music), and music closes only its
  own.
- A listener whose connection fails or drops is reopened while a flow still needs it, after 2 s, 4 s, 8 s and so on,
  up to 60 s between attempts (longer during a TeamSpeak flood cooldown). Authentication and host-key failures are
  not retried.
- A listener only hears chat in the channel it sits in. It read its own client id from the first line of the
  `whoami` reply only, so when that line was something else it never moved into its channel yet logged itself as
  ready, and the flow got no commands. The id is now read from any line (with one more `whoami` if needed), the
  move is checked, and a listener that cannot join its channel is reopened with the same backoff.
- Files: `packages/backend/src/bot-engine/event-bridge.ts`, `bot-engine/ssh-query-client.ts`,
  `bot-engine/engine.ts`, `voice/commands/channel-ownership.ts`.

## Security

- `TRUST_PROXY` is upstream's own now (it was ported from 1.11 before the merge). The all-in-one image defaults to
  `loopback`; behind a reverse proxy (Caddy, nginx, Traefik) set `TRUST_PROXY=loopback,<proxy address>`, or every user
  shares one login rate limit. The fork keeps one extra test for an edge proxy in front of the bundled nginx.
- Refresh tokens are stored as SHA-256 hashes. Unhashed rows are deleted at startup, so everyone signs in once more.
- `JWT_REFRESH_EXPIRY` now sets the refresh token lifetime (it was ignored: always 7 days). A bad value stops startup.
- Login runs one bcrypt comparison for unknown and disabled users too, so timing no longer shows which usernames exist.
- Webhook secrets are accepted only in the `X-Webhook-Secret` header, not as `?secret=` (one warning is logged if used).
- Player widget tokens are compared in constant time. They still travel in the URL (`?token=`), so they still reach
  access logs: TeamSpeak clients and embeds fetch these widgets as plain URLs and cannot send a header. The token only
  gives read access to that bot's now-playing data, and revoking it still means rotating `JWT_SECRET`.

## Merged with upstream 1.11.4

Where upstream and this fork changed the same thing:

- **Viewer offer**: the send-only offer for TeamSpeak 6.0.0-beta5 is in upstream 1.11.2 too; upstream's code is kept,
  with this fork's RTCP readers on the two senders.
- **Trust proxy**: upstream's implementation, see Security.
- **Start offset**: seek, resume and volume restarts send upstream's `startAtSecs`; the sidecar has one `-ss` per input.
- **Adaptive Auto quality** (upstream 1.11): steps use this fork's bitrate per resolution. It is off while the picture
  is copied (a direct stream, or a converted file), which has no encoder load to adapt to; a direct start that fell
  back to re-encoding live keeps it. Pause, resume and seek wait for a volume or quality restart
  in progress, and Auto quality does not restart while one of them is queued.
- **Sidecar forwarding**: upstream split it into helpers; keyframe pacing stays before forwarding and the VP9
  descriptor rewrite runs inside it. Upstream's GPU filter chain applies to re-encoded streams only.
- **Media command permissions** (upstream 1.11) and **Bot access** both apply, Bot access first; `!streamdirect` is in
  the video group.
- **Docs** moved to `docs/public/` upstream; the fork's additions moved with them.

## Known limits

- Playback of copied VP9 and H.264 in the real TeamSpeak client has not been fully confirmed. The client renders
  only Constrained-High H.264 without B-frames.
- YouTube's H.264 usually has B-frames, so direct streams from YouTube rely on VP9 or on the convert-first fallback.
- Direct streams use the source's bitrate for every viewer.
- The default video encoder is still VP8; a direct stream switches viewers to H.264 or VP9.
- Auto quality is chosen when a source starts. If viewers then settle on a codec the copied picture is not in, the
  stream is re-encoded with Auto quality still off until the next source.
- Bot access is checked when `!remote` hands out a listener remote, not on each use of it: someone removed from the
  control group keeps a remote already issued until it expires or they leave the channel.

## Deploying

This fork runs as an all-in-one image built locally from `Dockerfile.all-in-one`, not from the upstream
registries. Build with `--build-arg GIT_SHA=<commit>` so `/api/health` reports the commit. After the first start, the
bot-access list is empty (everybody may use the bot) until groups are added in Settings → Users → Bot access.

### Upgrading from the 1.10.1-based fork

The 1.11.4 merge brings upstream's 1.11 changes with it; upstream's
[upgrade notes](docs/public/upgrading.md#upgrading-to-1110) apply. In short:

- **Back up the data volume before the first start.** 1.11 changes the SQLite schema (a video queue table, Auto-DJ
  columns on bots, history columns on media requests), and startup applies it with `prisma db push`. Going back to an
  older image needs that backup as well as the old image.
- Behind a reverse proxy, keep `TRUST_PROXY=loopback,<proxy address>` (see Security).
- Media downloads go through a checking proxy inside the backend: `HTTP_PROXY` and `HTTPS_PROXY` no longer apply to
  them (`MEDIA_UPSTREAM_PROXY` does), and links to private, shared (100.64.0.0/10) or non-80/443 addresses are
  refused. Downloaded songs are kept in `.ts6-media-cache` inside the music folder; older files stay and keep playing.
- `!remote` (upstream's listener remote) needs an HTTPS public URL (`PUBLIC_URL`).
- Auto-DJ, 24/7 presence and the video queue are new and start off or empty.

## Tests

The sidecar's `go vet` and `go test ./...`, the backend and frontend unit suites, and the typecheck for common, backend
and frontend all pass (backend tests that read the proxy environment need it unset). The Settings limits card, which sets the seek and resume cooldowns, has a Playwright spec in
[`packages/frontend/tests/settings-limits.spec.ts`](packages/frontend/tests/settings-limits.spec.ts).
