# Media bots

TS6 Manager can run multiple TeamSpeak media bots per server. Each bot has independent playback, queue, and volume state.

## Bot Hub

**Automation → Bot Hub** (`/bot-hub`) is the list of media bots. Each card shows live connection/playback status, current media, channel, progress, volume, and, for video, quality, encoder, viewers, uptime, the no-viewer auto-stop countdown and last stop reason. Live status reads in-memory bot state; it does not probe the media sidecar or TeamSpeak Query.

Use **New bot** to create a bot with a single **Name**, used as both the admin label and TeamSpeak nickname. Names must be 3–30 characters; the web UI and API reject out-of-range nicknames before connecting. If the API request omits `nickname`, it uses `MediaBot`. Each card's settings menu provides **Edit bot**, **Start bot** or **Stop bot**, **Widget link**, and **Delete bot**. The same menu is available as **Bot settings** in the console header. Bots can reconnect automatically with exponential backoff and overlap protection.

![Bot Hub showing one playing bot and one idle bot](bot-hub.png)

A bot plays music **or** video, never both, and only one video stream runs at a time. See [Video streaming — one media session at a time](video-streaming.md#one-media-session-at-a-time). Start/stop failures use the [API error contract](api-errors.md).

## Bot console

Choose **Open console** on a Bot Hub card to open `/bot-hub/:botId`. **Now playing** shows that bot's current media and playback controls. **Up next** holds its music queue; use the drag handles to reorder with a mouse, touch or keyboard, play a queued item now, remove an item, or **Clear** the queue. With a keyboard, focus a drag handle, press Space to pick up, use the arrow keys to move, then press Space to drop or Escape to cancel.

![Bot console with Now playing, Up next and source tabs](musicbots.png)

Under **Play something**, choose a source:

- **Music** — Choose **Songs**, **Playlists**, or **Recent requests**; search songs by title or artist. The play button starts an item; the queue button adds it without interrupting playback.
- **Link** — Paste a supported URL and choose **Play as music** or **Stream as video**. For video, a filename can refer to a file already in the music folder; local music files play from **Music**. See [Video streaming](video-streaming.md).
- **Radio** — Search stations or filter by mood, then play a station. Moods come from each station's **Mood or genre** in **Media Library → Radio stations**.
- **IPTV** — Browse groups or search across playlists, filter by **Playlist**, and use **Favourites** or **Recent**. See [IPTV playlists](video-streaming.md#iptv-playlists).

Each **Play something** tab has a **+** link to the matching manage page: **Add songs**, **Add playlist** or **Manage requests** on Music, **Add files** on Link, **Add station** on Radio, and **Add playlist** on IPTV. The link only opens that page.

If the bot is offline, the console offers **Start bot** before showing its sources. When a start conflicts with an active media session, **Replace what is playing?** lists what will stop. Choose **Keep playing** to cancel or **Stop and switch** to replace it.

Radio and video keep the music queue. **Play queue** resumes the upcoming songs, with the replacement prompt when needed; while radio or video plays and nothing is queued, **Up next** is hidden. Radio shows the station and live status rather than track progress or skip controls. Music controls include pause/resume, skip and volume; **Up next** also provides **Shuffle** and repeat modes.

## Media Library

**Automation → Media Library** (`/media-bots`) manages media shared by every bot on a server. Select the server, then choose one of its five tabs:

| Tab | Purpose |
|-----|---------|
| **Library** | Manage local/downloaded songs and media imports. |
| **Playlists** | Create and edit saved playlists. |
| **Radio stations** | Add stations manually, from built-in presets, or by searching [Community Radio Browser](https://www.radio-browser.info/), then edit name, stream URL and mood or genre. **Play** on each station starts it on a running bot for the selected server. When several bots are running, pick the target under **Play on**. With no running bot, **Play** stays visible but disabled and the hint points to Bot Hub. |
| **Requests** | Review `!play` history and replay or enqueue a request. |
| **Streaming defaults** | Set defaults for future streams and auto-stop chat notices. |

Use a bot's console to choose sources and control playback. Changes to video options in the console apply to that one stream; **Streaming defaults** stay as they are. The console's source lists offer 25, 50 or 100 items per page and remember the chosen size for each list.

Old links still work: `/music-bots` redirects to `/media-bots`; the old **Bots** tab goes to Bot Hub, and **Queue** with a bot ID goes to its console. **Video** with a bot ID goes to the console, otherwise to **Streaming defaults**. **Commands** goes to **Bot Flows → Chat commands**.

## Auto-stop chat notices

**Media Library → Streaming defaults → Announce auto-stops in chat** is enabled by default. When a bot stops music or radio because its channel is empty, it posts a line such as `Stopped the music: the channel was empty for 5 minutes.` or `Stopped radio: the channel was empty for 5 minutes.` Video auto-stops also explain an empty channel or lack of viewers, for example `Stopped the stream: nobody watched for 5 minutes.` The duration follows the configured timeout.

When the video no-viewer timeout is longer than 60 seconds, the bot warns one minute before stopping: `Nobody is watching. The stream stops in 1 minute.` A viewer joining cancels the warning timer and stop countdown. Timeouts of 60 seconds or less skip the warning. All notices use the existing TeamSpeak flood hold.

Turn **Announce auto-stops in chat** off and choose **Save defaults** to suppress both the warning and stop notices. Automatic stopping remains enabled. Video and IPTV use the notice setting saved when the stream starts; music and radio use the current setting when they auto-stop.

## Bot avatars

Open a bot's settings menu in Bot Hub or **Bot settings** in its console, choose **Edit bot**, and use **Avatar → Upload**, **Use default**, or **None**. Uploads accept PNG, JPEG or GIF images up to 200 KB, checked by image content. TeamSpeak 6 clients leave avatars larger than about 320×320 pixels blank, so the bot shrinks larger images to fit 300×300 (keeping the aspect ratio, and keeping GIF animation) before uploading them to TeamSpeak. This uses the `ffmpeg` already shipped in the images. Bot Hub and the console still show the original upload.

New bots created in the web UI use the bundled TS6 Manager app icon by default. Existing bots start with **None**. The chosen image appears on Bot Hub cards and in the console header, even when TeamSpeak refuses the upload. Bot Flows query clients do not use avatars.

The bot uploads and confirms its selected image whenever it connects or the avatar changes. Its TeamSpeak server group must allow file uploads. If TeamSpeak refuses an upload, the bot stays connected and settings show:

> TeamSpeak refused the avatar upload. Allow file uploads for the bot's server group, or choose None.

Choosing **None** clears the avatar and asks TeamSpeak to delete the uploaded file. If TeamSpeak refuses the deletion, the old file remains on the server without being displayed as the bot's avatar.

## Requests

**Media Library → Requests** (`/media-bots?tab=requests`) shows `!play` history for the selected server. **Play** starts that request immediately. **Enqueue** adds it to the queue without interrupting current playback. When several bots are running, pick the target bot. `/music-requests` redirects here. System → Music Request History is no longer a separate page.

## Sources

Music bots support:

- radio streams with ICY metadata;
- YouTube playback through yt-dlp;
- Spotify and Apple Music media resolution through the supported resolver path;
- local files and downloaded media; and
- saved playlists.

Local/downloaded tracks are decoded incrementally at media speed to keep memory use bounded on long tracks.

## Playlists

Playlists are shared by every media bot on the same TeamSpeak server. Create and edit them in **Media Library → Playlists**, then start or enqueue them from any bot's **Music → Playlists** view. Chat `!playlist` and `!pl` use the same server-wide list, including playlists created for another bot.

## Channel text commands

When a bot is connected to a configured command channel, users in that channel can use built-in commands.

- **`!help`** — Show built-in and custom commands
- **`!here [id]`** / **`!come [id]`** — Summon an idle music bot to your channel (or target a bot by ID)
- **`!commands`** — List enabled custom chat commands only
- **`!play <url>`** — Play supported media
- **`!play <song name>`** — Search YouTube Music and play the best match (falls back to a regular YouTube search). Queues it if something is already playing
- **`!play`** — Resume paused playback
- **`!queue [show|clear|remove <n>|play <n>|<url>]`** — Show or manage the queue
- **`!add <url>`** — Alias for adding to the queue
- **`!playlist [name-or-id]` / `!pl <name-or-id>`** — List or append a saved playlist
- **`!repeat [off|track|queue]`** — Show or set repeat mode
- **`!seek <seconds|+seconds|-seconds>`** — Seek within a track or a non-live video (YouTube included). Live streams and radio cannot be seeked
- **`!remove <text>`** — Remove one unambiguous upcoming match
- **`!shuffle [on|off]`** — Toggle or set shuffle
- **`!stop`** — Stop playback and clear the music queue, including a playlist still expanding in the background. **Stop media** on a Bot Hub card does the same.
- **`!pause`** — Toggle pause/resume
- **`!skip` / `!next`** — Advance the queue
- **`!prev`** — Previous track
- **`!vol [0-100]` / `!volume [0-100]`** — Show or set the bot volume. The same level is used for music, radio, video, and IPTV.
- **`!np` / `!nowplaying`** — Show the current track
- **`!radio [id]`** — List or play radio stations
- **`!stream <url> [preset]`** — Start a video stream. Without a preset, a YouTube or Twitch link starts at Auto quality (up to the Auto quality limit) and any other URL at the bot's stored preset (720p by default), because Auto opens the source once more to measure it; `auto`, `480p`, `720p`, `1080p`, `1440p` or `2160p` sets it
- **`!stopstream`** — Stop the active video stream
- **`!viewers`** — List stream viewers
- **`!channels [search]`** — List/search IPTV channels
- **`!tv <name>` / `!iptv <name>`** — Stream an IPTV channel
- **`!lyrics [artist - title]`** — Show/search lyrics

Custom chat commands are configured in **Bot Flows → Chat commands**, alongside the built-in list and clash warnings. See [Bot Flows](bot-flows.md).

### Several bots in one channel

When more than one bot shares a command channel, exactly one of them answers. Name the bot to choose it: `!next Bot 2` when the command takes no other arguments, or `!vol 30 @Bot 2` when it does. The name is the bot's configured name; matching ignores case and extra spaces. An unknown name stays part of the command, so `!playlist Test` still looks up that playlist.

With no name, the bot that is playing, paused or streaming answers. If none is, the lowest bot id answers; if more than one is, the lowest id among those active bots answers. `!help` shows the name syntax.

### Custom command presets

**Bot Flows → Chat commands** can seed recommended server-scoped canned replies shared by every music bot on that connection:

| Command | Purpose |
|---------|---------|
| `!rules` | Server rules text |
| `!links` | Useful links (website, Discord, donate, …) |
| `!discord` | Discord invite (optional; can fold into `!links`) |
| `!info` / `!about` | Short community blurb |

Seeded presets start **disabled**. Edit the placeholder Markdown, then enable. `!commands` is a built-in that lists enabled customs (also shown under Custom in `!help`). Multiple bots on the same channel only send one informational reply (`!help` / `!commands` / customs) per user within a short cooldown.

A `!command` that is not built in, not an enabled custom command and not a Bot Flow command trigger gets a short **Unknown command** reply pointing to `!help` and `!commands`, with a "Did you mean…" hint for near-miss typos such as `!plya`.

## Download progress

Explicit library downloads run as bounded background jobs and can expose:

- current and total item counts;
- yt-dlp percentage;
- speed;
- ETA;
- processing state; and
- failure status.

Progress endpoints require an authenticated administrator, the matching server, and the requesting user. Jobs are kept in memory, capped, and expire automatically. A backend restart clears progress history.

## yt-dlp lifecycle

Production containers do not self-update yt-dlp.

The tool is installed at image build time and validated alongside FFmpeg, Node, and Deno. Deno (pinned in `.deno-version`) is the only yt-dlp JavaScript runtime configured for YouTube challenge solving (`--js-runtimes deno`). Image Node remains 20 for the Nest backend and is not an EJS fallback. To update the bundled extractor or Deno, pull a newer TS6 Manager image and recreate the container, or rebuild from a fresh image build.

Administrators can confirm the currently bundled yt-dlp (and related media tools) with the demand-driven Runtime / media check on Settings → YouTube or Media Library → Library. That check is not part of live bot status polling.

A public-video smoke test is intentionally not a release gate because media availability, rate limits, and regional restrictions are external to the project.

## Restricting who can use the bot, and limiting seeks

Both settings are in the web panel (admin only) and apply at once, with no restart. Nothing is read from environment variables.

- **Settings → Users → Bot access**: one or more TeamSpeak server groups, chosen from the groups of the selected server or typed by name or id. When the list is not empty, only clients in one of those groups can use the built-in chat commands (`!play`, `!stop`, `!seek`, `!help` and the rest). Everybody else gets one short refusal every 30 seconds, in the channel where they typed, and the command is not run (this includes `!here`, `!come` and `!help` typed in a channel the bot is not in). The sender's groups are read from TeamSpeak at every command, so taking the group away stops access at once. If TeamSpeak cannot be asked, or a listed group (a name or a numeric id) does not exist, nobody in that group is allowed, and the server log says which entry matched no server group. An empty list (the default) means everybody can. Custom chat commands, viewing a video stream and the web panel are not affected.
- **Settings → YouTube → Download & Stream Limits → Seek cooldown**: how long a bot waits between two seeks on a **remote** source (a YouTube track or video, a link, a radio URL). Default `120` seconds, `0` turns it off. A seek reopens the remote resource, so this keeps repeated seeks from hammering the site. The limit counts for the whole bot, whoever asks. A seek in a file that is already on the server (a downloaded track or video) is never limited. A refused chat `!seek` tells the user how long to wait, the API answers `429`, and a flow's Voice Seek step is skipped.

Both changes are written to the audit history (`settings.bot_access_update`, `settings.limits_update`).

## Direct streams (no re-encoding) and pausing a video

Normally the sidecar decodes every video and encodes it again for TeamSpeak, which costs a lot of CPU
(a 1080p picture can take more than one core). A **direct stream** sends the video as it is.

**Where to turn it on.** Bot console → Link tab → *Video options* → *Streaming mode* → *Direct: no re-encoding*
(for that start only). In chat: `!streamdirect <url> [preset]`, which is `!stream` with the same switch on.
Nothing is stored: the default stays *Re-encode*.

**What it needs.** Two kinds of picture can be copied:

- **VP9** (profile 0, 8-bit 4:2:0). Its hidden frames travel in the same packet as the frame that follows, so every
  packet is already in display order. This is what YouTube serves at 720p and above, so a YouTube video is asked for in
  VP9 first.
- **H.264** (8-bit 4:2:0) **without B-frames**. Viewers decode packets in the order they arrive, and a B-frame stream is
  sent out of display order. YouTube's own H.264 has B-frames, so it is only copied when a video happens to have none
  (most screen recordings, Twitch VODs, files you encode with `-bf 0`).

Only a downloaded or local file is checked (one short `ffprobe`); a remote URL (IPTV, an HLS link, YouTube direct mode)
is always re-encoded, and so is AV1, HEVC, 10-bit or any other picture. When the file cannot be copied the stream **still
plays, re-encoded**, and the reason is shown on the *Now playing* card and in the chat reply. Viewers keep the codec they
negotiated for the whole stream: a later source in another codec is re-encoded to the codec already in use.

**Trade-offs.** Almost no CPU. The bandwidth is the file's own bitrate (a 1080p YouTube video is often 3–5 Mbps,
against about 1.5 Mbps re-encoded) for every viewer. A viewer who joins late waits for the next keyframe (up to a few
seconds). After a seek or a resume the video starts at the keyframe before the requested time. The audio is still
encoded to Opus. The mode is chosen when the stream starts: changing the source keeps it, and `!streamdirect` on a
running re-encoded stream asks you to `!stopstream` first.

**Lost packets.** A video sent as it is has a keyframe only as often as its source does (YouTube: every few seconds),
so one lost packet used to freeze the picture until the next keyframe while the audio went on. The sidecar now offers
NACK to viewers and reads their feedback, so a lost packet is sent again within a few milliseconds. `GET /stats` on the
sidecar shows `retransmissionRequests` and `keyframeRequests`; if the picture still freezes and the first stays at 0,
the viewer is not asking for resends.

**VP9 packet descriptor.** ffmpeg's VP9 packetizer labels every packet with the same one-byte descriptor, which
tells a receiver that every frame is a keyframe and carries no picture number. After a lost packet the receiver then
decodes the following frames against a missing reference and the picture breaks up or freezes, without ever asking for a
keyframe. For a copied VP9 the sidecar rewrites the descriptor the way libwebrtc's own sender writes it (15-bit picture
id, "predicted" bit on every frame but a real keyframe, layer index, TL0PICIDX, and on keyframes the structure that
says each picture depends on the one before). Measured with headless Chromium on the same video and 2% packet loss:
10-27 s of frozen picture in 40 s before, about 2.5 s after. H.264 is not affected.

**Keyframe bursts.** ffmpeg writes all the packets of a frame at the same instant, and a keyframe of a copied video
is often ten times a normal frame: hundreds of packets at once can overflow a queue on the way (the viewer's router,
Wi-Fi), and the lost ones freeze the picture. For direct streams the sidecar therefore spreads the packets of each
frame over time, at a multiple of the video's own measured bitrate (Light 4×, Normal 2.5×, Strong 1.5×; a keyframe may
arrive up to 0.6 s later, and the audio is aligned to it). Choose it in *Media Library → Streaming defaults → Direct
streams: smooth keyframes* (also per server); *Off* sends frames as they come. It never touches a re-encoded stream.

**When the picture cannot be copied.** H.264 with B-frames (most files, including recorded TV),
AV1, HEVC and 10-bit pictures cannot be sent as they are. By default the manager then **converts the whole video once**
into H.264 without B-frames (x264 `ultrafast`, a keyframe every second, at the quality the stream was asked for and
never larger than the source), and **only when the conversion is finished** starts the stream, now copying the converted
file. A source is read through the sidecar's network rules, as for streaming it. While it converts, the *Now playing*
card shows the progress and a *Cancel* button (`!stopstream` cancels too), the chat is told when the conversion starts and
ends, and the page answers "still starting" after 20 s instead of waiting for the end. The converted file is the one
paused, seeked and copied afterwards (no remote reopening). Choose the speed, or turn it off, in *Streaming defaults →
Direct streams: when the picture cannot be copied* (also per server): *x264 ultrafast / superfast / veryfast* (a slower
preset gives a better picture for the same size) or *Re-encode while it plays* (no wait, the old behaviour).

Not converted, and re-encoded while they play instead, with the reason on the card and in chat: a live source (it has no
end), a video longer than *Max video duration* (default 15 min; raise it in Settings for long videos), a conversion that
fails, and a source that cannot be inspected. Only one conversion runs at a time. The sidecar writes the result as
`.stream-<digits>.mp4` in the music folder and it is deleted when the stream ends.

**Pausing a video.** The *Now playing* card has *Pause* / *Resume* for a finite video, and `!pause` toggles it in
chat, as for music. Pausing stops the encode and remembers the position; the viewers stay connected and keep the last
picture. Resume starts again from that position (a video without a local copy is opened again on its site, so it
counts as a seek for the seek cooldown). Live streams and looping videos cannot be paused. A seek while paused plays
from the target; a volume change while paused is applied when it plays again. Pause/resume also work through
`POST /api/music-bots/:id/pause` and `/resume`, which now handle video as well.

