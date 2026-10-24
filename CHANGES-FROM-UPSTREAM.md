# Changes from upstream

This fork starts from [uniskela/ts6-manager](https://github.com/uniskela/ts6-manager) v1.10.1
(commit [`7d81468`](https://github.com/uniskela/ts6-manager/commit/7d814684c65369b8ba3f8cf68843dd79283a0938))
and three later upstream commits that only touch documentation and CI. Upstream has since released 1.11.x, and these
changes have not been rebased onto it yet.

The new settings live in the database and are edited in the web GUI. There are no new environment variables, and the
database schema is the same as upstream's: each new setting is a key/value row with a built-in default.

[`docs/music-bots.md`](docs/music-bots.md) and [`docs/video-streaming.md`](docs/video-streaming.md) cover each
feature in more detail.

## Summary

| Feature | Setting (DB key) | Default | Where in the GUI |
|---|---|---|---|
| Video seek | none | | `!seek`, Now playing card |
| Seek cooldown | `seek_cooldown_seconds` | `120` s (`0` = off) | Settings → YouTube → Download & Stream Limits |
| Resume cooldown | `resume_cooldown_seconds` | `10` s (`0` = off) | API only for now (`PUT /api/settings/limits`) |
| Bot access | `bot_control_groups` | empty (everybody) | Settings → Users → Bot access |
| Direct streams | none, chosen per start | Re-encode | Bot console → Link → Video options → Streaming mode |
| Video pause/resume | none | | Now playing card, `!pause` |
| Retransmission (NACK) | none | always on | |
| VP9 descriptor rewrite | none | always on for copied VP9 | |
| Keyframe pacing | `video_direct_pacing` | `2.5` (`0` = off, 1 to 10) | Media Library → Streaming defaults (also per server) |
| Encode threads | `video_encode_threads` | `0` (automatic) | Media Library → Streaming defaults → Advanced (also per server) |
| Convert-first fallback | `video_direct_fallback` | `ultrafast` | Media Library → Streaming defaults (also per server) |
| Bitrate per resolution | `video_preset_bitrates` | see below | Media Library → Streaming defaults (also per server) |
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

- API: the sidecar's `POST /source` accepts `startSeconds`.
- Files: `packages/backend/src/voice/voice-bot.ts`, `voice/commands/playback.ts`, `voice/streaming/sidecar-client.ts`,
  `packages/sidecar/main.go`.

### Seek cooldown

Each seek on a remote source (a YouTube track or video, a link, a radio URL) reopens it, so a bot waits this long
between two such seeks, whoever asks. Seeks in a file that is already on the server are never limited.

- Setting `seek_cooldown_seconds`, default `120`, range `0` to `86400`, `0` turns it off.
- API: `PUT /api/settings/limits` accepts `seekCooldownSeconds`. A refused seek answers `429` on
  `POST /api/music-bots/:id/seek` and `/resume`; in chat the user is told how long to wait; a flow's Voice Seek step
  is skipped with a warning.
- Resume cooldown: setting `resume_cooldown_seconds`, default `10`, range `0` to `3600`, `0` turns it off, set with
  `resumeCooldownSeconds` on the same endpoint. It only limits resuming a paused video that has no local copy, and a
  refused resume answers `429`.
- Audit: `settings.limits_update`.
- Files: `packages/backend/src/utils/app-settings.ts`, `routes/settings.routes.ts`, `voice/voice-bot-manager.ts`,
  `bot-engine/flow-runner.ts`.

### Bot access control

Only members of the chosen TeamSpeak server groups can use the built-in chat commands (`!play`, `!stop`, `!seek`,
`!help` and the rest, including the cross-channel `!here`, `!come` and `!help`).

- Setting `bot_control_groups` (group names or ids). Default empty, which means everybody can use the bot.
- The manager asks TeamSpeak for the sender's groups at every command, so taking a group away works at once. If
  TeamSpeak does not answer, or a listed group does not exist, nobody is allowed. Anyone refused gets one short reply
  every 30 seconds, and the command does not run.
- Custom chat commands, watching a video stream and the web panel are not restricted.
- API (new, admin only): `GET /api/settings/bot-access` and `PUT /api/settings/bot-access` with
  `{ "controlGroups": ["..."] }`. Entries are trimmed and de-duplicated without regard to case.
- Audit (new): `settings.bot_access_update`.
- Files: `packages/backend/src/voice/commands/authorization.ts` (new), `voice/commands/routing.ts`,
  `voice/commands/context.ts`, `voice/chat-commands.ts`, `routes/settings.routes.ts`,
  `packages/frontend/src/pages/Settings.tsx`, `api/settings.api.ts`, `pages/AuditHistory.tsx`.

### Direct streams (no re-encoding) and `!streamdirect`

A direct stream sends the video as it is, without decoding and encoding it again, so it uses almost no CPU.

- It can copy VP9 profile 0 (8-bit 4:2:0) and H.264 (8-bit 4:2:0) without B-frames. Only a downloaded or local
  file is checked, with one short `ffprobe`. Remote URLs, AV1, HEVC, 10-bit and H.264 with B-frames are not copied
  (see the convert-first fallback below), and the Now playing card and the chat reply say why.
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

### Encode threads

The software VP8 and VP9 encoders were given one thread per CPU the sidecar process could see. A container limited to
3 CPUs on a 6-core host still saw 6, so ffmpeg ran 6 threads inside a 3-CPU budget and was throttled. The default is
now the smaller of the visible CPUs and the container's CPU quota (cgroup v1 or v2).

- Setting `video_encode_threads`: `0` (default) = automatic, otherwise 1 to 64. `VIDEO_ENCODE_THREADS` still applies
  when the setting is `0`. Also settable per server. The sidecar's `POST /source` and `POST /convert` accept `threads`.
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
- The conversion uses at most 2 x264 threads (`VIDEO_CONVERT_THREADS` overrides), so it cannot take the CPUs a live
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

### Command listener race (bot flows)

Two concurrent calls could open two SSH command listeners for the same channel, so a chat command ran its flow
twice. Listeners being set up are now tracked, and a listener whose first connection timed out (which never retries
by itself) is replaced, up to three attempts.

- File: `packages/backend/src/bot-engine/event-bridge.ts`.

## Known limits

- Playback of copied VP9 and H.264 in the real TeamSpeak client has not been fully confirmed. The client renders
  only Constrained-High H.264 without B-frames.
- YouTube's H.264 usually has B-frames, so direct streams from YouTube rely on VP9 or on the convert-first fallback.
- Direct streams use the source's bitrate for every viewer.
- The default video encoder is still VP8; a direct stream switches viewers to H.264 or VP9.

## Deploying

This fork runs as an all-in-one image built locally from `Dockerfile.all-in-one`, not from the upstream
registries. Build with `--build-arg GIT_SHA=<commit>` so `/api/health` reports the commit. After the first start, the
bot-access list is empty (everybody may use the bot) until groups are added in Settings → Users → Bot access.

## Tests

Sidecar `go vet` and `go test ./...` pass; typecheck is clean for common, backend and frontend; backend 974 tests pass
(4 skipped); frontend 181 unit tests pass.
