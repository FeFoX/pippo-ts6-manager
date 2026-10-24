package main

import (
	"strings"
	"testing"
)

func ffmpegArgLine(req SourceRequest) string {
	s := NewSidecar()
	spec, _ := lookupEncoder("vp8")
	return strings.Join(s.buildFFmpegArgs(req, spec, false), " ")
}

func TestParseAndValidateExtraFFmpegArgs(t *testing.T) {
	got, err := parseFFmpegArgs(`-user_agent IPTV -headers "Referer: https://cdn.example/\r\n"`)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 || got[0] != "-user_agent" || got[1] != "IPTV" || got[2] != "-headers" {
		t.Fatalf("tokens: %#v", got)
	}
	if got[3] != "Referer: https://cdn.example/\r\n" {
		t.Fatalf("header value: %#v", got[3])
	}
	if err := validateExtraFFmpegArgs(got); err != nil {
		t.Fatal(err)
	}
	if _, err := parseFFmpegArgs(`-user_agent "unterminated`); err == nil {
		t.Fatal("unbalanced quote must fail")
	}
	if err := validateExtraFFmpegArgs([]string{"-reconnect", "1", "-i"}); err == nil {
		t.Fatal("-i must be refused")
	}
	if err := validateExtraFFmpegArgs([]string{"https://evil.example/out.ts"}); err == nil {
		t.Fatal("bare URL must be refused")
	}
	if err := validateExtraFFmpegArgs([]string{"rtp://127.0.0.1:9"}); err == nil {
		t.Fatal("rtp URL must be refused")
	}
}

func TestBuildFFmpegArgsClosesRemoteHTTPConnections(t *testing.T) {
	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "")
	for _, persistence := range []string{"auto", "0", "1"} {
		t.Setenv("FFMPEG_HTTP_PERSISTENT", persistence)
		for _, source := range []string{"https://cdn.example/a.m3u8?token=1", "https://cdn.example/get.php", "https://cdn.example/live.ts", "https://cdn.example/clip.mp4"} {
			for _, mode := range []string{modeLive, modeVOD} {
				got := ffmpegArgLine(SourceRequest{Source: source, Mode: mode, Volume: 100})
				if strings.Contains(got, "http_persistent") {
					t.Fatalf("HLS-only option must not be guessed from the URL: %s", got)
				}
				if strings.Contains(got, "Connection: close\r\n") != (persistence != "1") {
					t.Fatalf("persistence=%s source=%s: %s", persistence, source, got)
				}
				if !strings.Contains(got, "-re -i "+source) {
					t.Fatalf("read pacing must stay adjacent to its input: %s", got)
				}
			}
		}
	}
	local := ffmpegArgLine(SourceRequest{Source: "/data/music/clip.mp4", Volume: 100})
	if strings.Contains(local, "Connection:") || strings.Contains(local, "-reconnect") {
		t.Fatalf("local file must not get HTTP options: %s", local)
	}
	t.Setenv("FFMPEG_HTTP_PERSISTENT", "auto")
	split := ffmpegArgLine(SourceRequest{Source: "https://v.example/get.php", AudioSource: "https://a.example/audio.mp4", Mode: modeLive, Volume: 100})
	if strings.Count(split, "Connection: close\r\n") != 2 {
		t.Fatalf("each remote input must close its connections: %s", split)
	}
	t.Setenv("VIDEO_LIVE_PACING", "source")
	paced := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/get.php", Mode: modeLive, Volume: 100})
	if strings.Contains(paced, "-re ") || !strings.Contains(paced, "Connection: close\r\n") {
		t.Fatalf("source pacing drops -re but keeps connection closing: %s", paced)
	}
}

func TestExtraFFmpegArgsOverrideAndReject(t *testing.T) {
	t.Setenv("FFMPEG_HTTP_PERSISTENT", "auto")
	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", `-user_agent IPTV -headers "Referer: https://cdn.example/\r\nconnection: keep-alive\r\n"`)
	got := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/get.php", Volume: 100})
	if !strings.Contains(got, "Referer: https://cdn.example/\r\nConnection: close\r\n") || strings.Contains(got, "keep-alive") || strings.Count(got, "-headers ") != 1 {
		t.Fatalf("custom headers must survive connection closing: %s", got)
	}
	if strings.Index(got, "-user_agent IPTV") > strings.Index(got, "-i https://") {
		t.Fatalf("extra arguments must stay before their input: %s", got)
	}
	t.Setenv("FFMPEG_HTTP_PERSISTENT", "1")
	restored := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/get.php", Volume: 100})
	if !strings.Contains(restored, "connection: keep-alive") || strings.Contains(restored, "Connection: close") {
		t.Fatalf("persistence override must leave custom headers intact: %s", restored)
	}
	t.Setenv("FFMPEG_HTTP_PERSISTENT", "auto")

	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "-user_agent LOCAL")
	local := ffmpegArgLine(SourceRequest{Source: "/data/music/clip.mp4", Volume: 100})
	if strings.Contains(local, "LOCAL") || strings.Contains(local, "-user_agent") {
		t.Fatalf("extra input args are remote-only: %s", local)
	}

	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", `-headers "Referer: https://cdn.example/\r\n"`)
	t.Setenv("FFMPEG_EXTRA_OUTPUT_ARGS", "-metadata title=Channel")
	remote := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/clip.mp4", Mode: modeVOD, Volume: 100})
	if !strings.Contains(remote, "Referer: https://cdn.example/") {
		t.Fatalf("header value may contain a URL: %s", remote)
	}
	if strings.Count(remote, "-metadata title=Channel -f rtp") != 2 {
		t.Fatalf("extra output args go before each RTP muxer: %s", remote)
	}
	if strings.Contains(remote, "http_persistent") {
		t.Fatalf("headers must not imply the HLS option: %s", remote)
	}

	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "-user_agent ok -i https://evil.example/added.ts")
	t.Setenv("FFMPEG_EXTRA_OUTPUT_ARGS", "https://evil.example/out.ts")
	rejected := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/clip.mp4", Mode: modeVOD, Volume: 100})
	if strings.Contains(rejected, "evil.example") || strings.Contains(rejected, "-user_agent") || strings.Count(rejected, " -i ") != 1 {
		t.Fatalf("unsafe extra args must be ignored entirely: %s", rejected)
	}

	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", `-user_agent "unterminated`)
	t.Setenv("FFMPEG_EXTRA_OUTPUT_ARGS", "")
	broken := ffmpegArgLine(SourceRequest{Source: "https://cdn.example/a.m3u8", Volume: 100})
	if strings.Contains(broken, "unterminated") || !strings.Contains(broken, "Connection: close\r\n") {
		t.Fatalf("a bad extra value is ignored and the default remains: %s", broken)
	}
}

func TestBuildFFmpegArgsPassthroughCopiesVideo(t *testing.T) {
	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "")
	got := ffmpegArgLine(SourceRequest{
		Source: "/data/music/clip.mp4", Mode: modeFile, Volume: 100,
		Width: 1280, Height: 720, Framerate: 30, Bitrate: "1500k", Passthrough: true,
	})
	for _, want := range []string{"-map 0:v:0 -c:v copy -bsf:v h264_mp4toannexb", "-f rtp", "-c:a libopus"} {
		if !strings.Contains(got, want) {
			t.Fatalf("direct stream must contain %q: %s", want, got)
		}
	}
	// Nothing may touch the picture: no filter graph, no encoder, no rate control.
	for _, bad := range []string{"-vf", "scale=", "libx264", "libvpx", "-b:v", "-maxrate", "-bufsize", "-preset"} {
		if strings.Contains(got, bad) {
			t.Fatalf("direct stream must not contain %q: %s", bad, got)
		}
	}
}

func TestBuildFFmpegArgsReencodeStillFiltersAndEncodes(t *testing.T) {
	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "")
	got := ffmpegArgLine(SourceRequest{
		Source: "/data/music/clip.mp4", Mode: modeFile, Volume: 100,
		Width: 1280, Height: 720, Framerate: 30, Bitrate: "1500k",
	})
	for _, want := range []string{"-vf", "scale=1280:720", "-b:v 1500k"} {
		if !strings.Contains(got, want) {
			t.Fatalf("re-encode must contain %q: %s", want, got)
		}
	}
	if strings.Contains(got, "-c:v copy") {
		t.Fatalf("re-encode must not copy: %s", got)
	}
}

func TestStartFFmpegPassthroughNeedsH264(t *testing.T) {
	s := NewSidecar()
	_, err := s.StartFFmpeg(SourceRequest{Source: "/data/music/clip.mp4", Encoder: "vp8", Passthrough: true})
	if err == nil || !strings.Contains(err.Error(), "H.264 or VP9") {
		t.Fatalf("a VP8 direct stream must be refused, got %v", err)
	}
}

func TestBuildFFmpegArgsPassthroughVP9(t *testing.T) {
	t.Setenv("FFMPEG_EXTRA_INPUT_ARGS", "")
	s := NewSidecar()
	spec, _ := lookupEncoder("vp9")
	got := strings.Join(s.buildFFmpegArgs(SourceRequest{
		Source: "/data/music/clip.mp4", Mode: modeFile, Volume: 100, Passthrough: true,
		Width: 1280, Height: 720, Framerate: 30, Bitrate: "1500k",
	}, spec, false), " ")
	for _, want := range []string{"-map 0:v:0 -c:v copy -strict experimental", "-f rtp", "-c:a libopus"} {
		if !strings.Contains(got, want) {
			t.Fatalf("direct VP9 must contain %q: %s", want, got)
		}
	}
	for _, bad := range []string{"-bsf:v", "h264_mp4toannexb", "-vf", "libvpx", "-b:v"} {
		if strings.Contains(got, bad) {
			t.Fatalf("direct VP9 must not contain %q: %s", bad, got)
		}
	}
}

func TestRemoteInputsGetADeeperDemuxQueue(t *testing.T) {
	t.Setenv("FFMPEG_THREAD_QUEUE_SIZE", "")
	s := NewSidecar()
	spec, _ := lookupEncoder("h264")
	split := strings.Join(s.buildFFmpegArgs(SourceRequest{
		Source: "https://v.example/video", AudioSource: "https://a.example/audio", Mode: modeLive, Volume: 100,
	}, spec, false), " ")
	// Input options apply to the next -i only: each remote input needs its own, before its -i.
	if n := strings.Count(split, "-thread_queue_size 512"); n != 2 {
		t.Fatalf("want one queue option per remote input, got %d: %s", n, split)
	}
	if q, i := strings.Index(split, "-thread_queue_size"), strings.Index(split, "-i https://v.example/video"); q < 0 || q > i {
		t.Errorf("the queue option must come before the first -i: %s", split)
	}
	// A local file is read from disk and needs none.
	local := ffmpegArgLine(SourceRequest{Source: "/data/music/clip.mp4"})
	if strings.Contains(local, "-thread_queue_size") {
		t.Errorf("a local file needs no demux queue: %s", local)
	}
}

func TestThreadQueueSizeCanBeChangedOrTurnedOff(t *testing.T) {
	t.Setenv("FFMPEG_THREAD_QUEUE_SIZE", "128")
	if got := strings.Join(threadQueueArgs(), " "); got != "-thread_queue_size 128" {
		t.Errorf("env should set the size: %q", got)
	}
	t.Setenv("FFMPEG_THREAD_QUEUE_SIZE", "0")
	if got := threadQueueArgs(); got != nil {
		t.Errorf("0 leaves ffmpeg's default: %v", got)
	}
	t.Setenv("FFMPEG_THREAD_QUEUE_SIZE", "99999999")
	if got := strings.Join(threadQueueArgs(), " "); got != "-thread_queue_size 65536" {
		t.Errorf("a huge value is capped: %q", got)
	}
}

// ffprobe rejects ffmpeg-only options, so the shared remote input options must not carry the queue size.
func TestSharedRemoteInputArgsStayProbeSafe(t *testing.T) {
	t.Setenv("FFMPEG_THREAD_QUEUE_SIZE", "512")
	for _, a := range remoteFFmpegInputArgs() {
		if a == "-thread_queue_size" {
			t.Fatal("remoteFFmpegInputArgs is shared with ffprobe, which has no -thread_queue_size")
		}
	}
	for _, a := range probeDirectArgs() {
		if a == "-thread_queue_size" {
			t.Fatal("ffprobe would fail on -thread_queue_size")
		}
	}
}
