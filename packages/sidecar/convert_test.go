package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func goodConvert() ConvertRequest {
	return ConvertRequest{
		Source: "music://clip.mp4", Output: "music://.stream-123.mp4",
		Width: 1280, Height: 720, Bitrate: "2500k", Preset: "ultrafast", Gop: 25, DurationSec: 120,
	}
}

func TestValidateConvertAcceptsAGoodRequestAndResolvesTheOutput(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MUSIC_DIR", dir)
	_ = os.WriteFile(filepath.Join(dir, "clip.mp4"), []byte("x"), 0o644)
	src, final, err := validateConvert(goodConvert())
	if err != nil {
		t.Fatal(err)
	}
	if src != filepath.Join(dir, "clip.mp4") || final != filepath.Join(dir, ".stream-123.mp4") {
		t.Fatalf("paths: %q %q", src, final)
	}
	// The output may also be given as a bare name, and the source as a remote address.
	req := goodConvert()
	req.Output = ".stream-9.mp4"
	req.Source = "https://cdn.example/video.mp4"
	if _, _, err := validateConvert(req); err != nil {
		t.Fatal(err)
	}
}

func TestValidateConvertRefusesWhatItShould(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MUSIC_DIR", dir)
	_ = os.WriteFile(filepath.Join(dir, "clip.mp4"), []byte("x"), 0o644)
	cases := map[string]func(*ConvertRequest){
		"no source":                  func(r *ConvertRequest) { r.Source = "" },
		"a local path outside music": func(r *ConvertRequest) { r.Source = "/etc/passwd" },
		"an output elsewhere":        func(r *ConvertRequest) { r.Output = "music://../evil.mp4" },
		"an output of another name":  func(r *ConvertRequest) { r.Output = "music://song.mp4" },
		"an output path":             func(r *ConvertRequest) { r.Output = "/data/music/.stream-1.mp4" },
		"a tiny picture":             func(r *ConvertRequest) { r.Width = 10 },
		"a huge picture":             func(r *ConvertRequest) { r.Height = 99999 },
		"a bitrate with options":     func(r *ConvertRequest) { r.Bitrate = "2500k -f null" },
		"an unknown preset":          func(r *ConvertRequest) { r.Preset = "placebo" },
		"a slow preset":              func(r *ConvertRequest) { r.Preset = "slow" },
		"no keyframe interval":       func(r *ConvertRequest) { r.Gop = 0 },
		"a negative length":          func(r *ConvertRequest) { r.DurationSec = -1 },
		"a negative source bitrate":  func(r *ConvertRequest) { r.SourceBitrateKbps = -5 },
		"too many threads":           func(r *ConvertRequest) { r.Threads = 500 },
		"an unknown cpu priority":    func(r *ConvertRequest) { r.CPUPriority = "high" },
		"too many convert threads":   func(r *ConvertRequest) { r.ConvertThreads = 500 },
		"negative convert threads":   func(r *ConvertRequest) { r.ConvertThreads = -1 },
	}
	for name, change := range cases {
		req := goodConvert()
		change(&req)
		if _, _, err := validateConvert(req); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}

func TestBuildConvertArgsMakesAFileTheStreamCanCopy(t *testing.T) {
	args := strings.Join(buildConvertArgs(goodConvert(), "/data/music/clip.mp4", nil, "/data/music/.stream-123.mp4.part"), " ")
	for _, want := range []string{
		"-c:v libx264 -preset ultrafast -profile:v high -bf 0",
		"-g 25 -keyint_min 25",
		"-crf 24 -maxrate 2500k -bufsize 5000k",
		"min(1280,iw)", "min(720,ih)", "format=yuv420p",
		"-c:a aac", "-movflags +faststart", "-f mp4 /data/music/.stream-123.mp4.part",
		"-progress pipe:1",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("missing %q in %s", want, args)
		}
	}
	// A conversion must go as fast as it can, never paced to real time.
	if strings.Contains(args, " -re ") {
		t.Errorf("must not read at real time: %s", args)
	}
}

func TestBuildConvertArgsPutsInputOptionsBeforeTheInput(t *testing.T) {
	input := []string{"-http_proxy", "http://127.0.0.1:9", "-reconnect", "1"}
	args := buildConvertArgs(goodConvert(), "https://cdn.example/v.mp4", input, "/x.part")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-http_proxy http://127.0.0.1:9 -reconnect 1 -i https://cdn.example/v.mp4") {
		t.Errorf("input options must come right before -i: %s", joined)
	}
}

func TestOnlyOneConversionRunsAtATime(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MUSIC_DIR", dir)
	_ = os.WriteFile(filepath.Join(dir, "clip.mp4"), []byte("x"), 0o644)
	s := NewSidecar()
	s.convert = &convertJob{status: ConvertStatus{ID: "abc", State: "running"}, cancel: func() {}}
	if _, err := s.StartConvert(goodConvert()); err != errConvertBusy {
		t.Fatalf("a second conversion must be refused as busy, got %v", err)
	}
}

func TestCancelMarksTheJobAndKeepsItReadable(t *testing.T) {
	cancelled := false
	s := NewSidecar()
	s.convert = &convertJob{status: ConvertStatus{ID: "abc", State: "running"}, cancel: func() { cancelled = true }}
	if s.CancelConvert("nope") {
		t.Fatal("an unknown id cannot be cancelled")
	}
	if !s.CancelConvert("abc") || !cancelled {
		t.Fatal("cancel must stop the process")
	}
	st, ok := s.ConvertStatusFor("abc")
	if !ok || st.State != "cancelled" {
		t.Fatalf("status after cancel: %+v %v", st, ok)
	}
	if _, ok := s.ConvertStatusFor("other"); ok {
		t.Fatal("another id is unknown")
	}
}

func TestFinishedJobsOutlastAPollButNotForever(t *testing.T) {
	s := NewSidecar()
	job := &convertJob{status: ConvertStatus{ID: "abc", State: "running"}, cancel: func() {}}
	s.convert = job
	job.finish("done", "")
	if st, ok := s.ConvertStatusFor("abc"); !ok || st.State != "done" || st.Percent != 100 {
		t.Fatalf("a finished job is readable: %+v %v", st, ok)
	}
	job.finish("failed", "late") // a second finish changes nothing
	if st, _ := s.ConvertStatusFor("abc"); st.State != "done" {
		t.Fatalf("state must not change after finishing: %+v", st)
	}
	job.mu.Lock()
	job.doneAt = job.doneAt.Add(-2 * convertKeepFinished)
	job.mu.Unlock()
	if _, ok := s.ConvertStatusFor("abc"); ok {
		t.Fatal("an old finished job must be forgotten")
	}
}

func TestProbeDirectArgsAskForWhatDecidesACopy(t *testing.T) {
	joined := strings.Join(probeDirectArgs(), " ")
	for _, want := range []string{"codec_name", "profile", "pix_fmt", "has_b_frames", "packet=pts,dts", "format=duration", "json"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q: %s", want, joined)
		}
	}
	_ = os.Getenv
}

func TestConvertMaxrateNeverExceedsTheSource(t *testing.T) {
	cases := []struct {
		requested string
		source    int
		want      string
	}{
		{"7000k", 500, "500k"},   // a small clip is not given the room of a 1080p stream
		{"7000k", 0, "7000k"},    // unknown source bitrate: the requested cap stands
		{"2500k", 4000, "2500k"}, // a richer source is still held to the stream's cap
		{"7M", 3000, "3000k"},
		{"2500k", 40, "100k"}, // never starved below the floor
	}
	for _, c := range cases {
		if got := convertMaxrate(c.requested, c.source); got != c.want {
			t.Errorf("convertMaxrate(%q, %d) = %q, want %q", c.requested, c.source, got, c.want)
		}
	}
	req := goodConvert()
	req.Bitrate = "7000k"
	req.SourceBitrateKbps = 500
	args := strings.Join(buildConvertArgs(req, "/music/clip.mp4", nil, "/music/.stream-1.mp4.part"), " ")
	if !strings.Contains(args, "-maxrate 500k") || !strings.Contains(args, "-bufsize 1000k") {
		t.Errorf("maxrate and bufsize must follow the source bitrate: %s", args)
	}
}

func TestBuildConvertArgsCapsTheThreads(t *testing.T) {
	t.Setenv("VIDEO_CONVERT_THREADS", "")
	t.Setenv("VIDEO_ENCODE_THREADS", "6")
	args := strings.Join(buildConvertArgs(goodConvert(), "/music/clip.mp4", nil, "/music/.stream-1.mp4.part"), " ")
	if !strings.Contains(args, "-threads 2") {
		t.Errorf("a conversion must not use every CPU: %s", args)
	}
	req := goodConvert()
	req.Threads = 1
	args = strings.Join(buildConvertArgs(req, "/music/clip.mp4", nil, "/music/.stream-1.mp4.part"), " ")
	if !strings.Contains(args, "-threads 1") {
		t.Errorf("a lower thread setting must apply to the conversion too: %s", args)
	}
	req.ConvertThreads = 4
	args = strings.Join(buildConvertArgs(req, "/music/clip.mp4", nil, "/music/.stream-1.mp4.part"), " ")
	if !strings.Contains(args, "-threads 4") {
		t.Errorf("the Convert threads setting must win: %s", args)
	}
}

func TestCancelOfAFinishedJobIsNotACancellation(t *testing.T) {
	cancelled := false
	s := NewSidecar()
	job := &convertJob{status: ConvertStatus{ID: "abc", State: "running"}, cancel: func() { cancelled = true }}
	s.convert = job
	job.finish("done", "")
	if s.CancelConvert("abc") || cancelled {
		t.Fatal("a job that already finished cannot be cancelled")
	}
	if st, _ := s.ConvertStatusFor("abc"); st.State != "done" {
		t.Fatalf("the finished state must stay: %+v", st)
	}
}

func TestSweepOrphanStreamFilesRemovesOnlyOldLeftovers(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	write := func(name string, age time.Duration) {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	write(".stream-100.mp4", 10*time.Hour)      // finished conversion nobody used
	write(".stream-101.mp4.part", 10*time.Hour) // conversion a restart cut short
	write(".stream-102.mp4", time.Minute)       // may belong to a stream that is running
	write(".stream-103.mp4.part", time.Minute)  // may belong to a download or conversion in progress
	write("song.mp4", 10*time.Hour)             // not ours
	write(".stream-x.mp4", 10*time.Hour)        // not ours
	removed := sweepOrphanStreamFiles(dir, orphanStreamFileAge, now)
	if len(removed) != 2 {
		t.Fatalf("removed %v", removed)
	}
	for _, name := range []string{".stream-102.mp4", ".stream-103.mp4.part", "song.mp4", ".stream-x.mp4"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s must be kept: %v", name, err)
		}
	}
	for _, name := range []string{".stream-100.mp4", ".stream-101.mp4.part"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			t.Errorf("%s must be removed", name)
		}
	}
}
