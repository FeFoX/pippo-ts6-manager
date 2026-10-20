package main

import (
	"math"
	"strings"
	"testing"
)

// A seek restarts ffmpeg with -ss on every input, so the video and the
// separate audio of a split source start at the same point.
func TestStartSecondsSeeksEveryInput(t *testing.T) {
	s := NewSidecar()
	spec, _ := lookupEncoder("h264")
	req := SourceRequest{
		Source: "https://v.example/video", AudioSource: "https://a.example/audio",
		Mode: modeVOD, Volume: 100, StartSeconds: 1800,
	}
	got := strings.Join(s.buildFFmpegArgs(req, spec, false), " ")
	if n := strings.Count(got, "-ss 1800.000"); n != 2 {
		t.Fatalf("-ss appears %d times, want once per input: %s", n, got)
	}
	for _, in := range []string{"-i https://v.example/video", "-i https://a.example/audio"} {
		i := strings.Index(got, in)
		if i < 0 {
			t.Fatalf("missing %q: %s", in, got)
		}
		// -ss is an input option: it must come before the -i it applies to.
		if j := strings.LastIndex(got[:i], "-ss 1800.000"); j < 0 {
			t.Errorf("no -ss before %q: %s", in, got)
		}
	}
}

func TestStartSecondsSingleSourceAndFile(t *testing.T) {
	s := NewSidecar()
	spec, _ := lookupEncoder("h264")
	for _, req := range []SourceRequest{
		{Source: "https://x.example/clip.mp4", Mode: modeVOD, Volume: 100, StartSeconds: 90.5},
		{Source: "/data/music/clip.mp4", Mode: modeFile, Volume: 100, StartSeconds: 90.5},
	} {
		got := strings.Join(s.buildFFmpegArgs(req, spec, false), " ")
		if strings.Count(got, "-ss 90.500") != 1 || strings.Count(got, " -i ") != 1 {
			t.Errorf("want one -ss before the one input for %q: %s", req.Source, got)
		}
	}
}

func TestStartSecondsIgnoredForLiveAndZero(t *testing.T) {
	s := NewSidecar()
	spec, _ := lookupEncoder("h264")
	live := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://x.example/live.m3u8", Mode: modeLive, Volume: 100, StartSeconds: 600}, spec, false), " ")
	if strings.Contains(live, "-ss ") {
		t.Errorf("a live source has no timeline to seek in: %s", live)
	}
	zero := strings.Join(s.buildFFmpegArgs(SourceRequest{Source: "https://x.example/clip.mp4", Mode: modeVOD, Volume: 100}, spec, false), " ")
	if strings.Contains(zero, "-ss ") {
		t.Errorf("no offset means no -ss: %s", zero)
	}
}

func TestClampStartSecondsDropsUnusableOffsets(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{0, 0}, {1800, 1800}, {90.5, 90.5}, {-5, 0}, {math.NaN(), 0}, {math.Inf(1), 0}, {math.Inf(-1), 0},
	}
	for _, tc := range cases {
		if got := clampStartSeconds(tc.in); got != tc.want {
			t.Errorf("clampStartSeconds(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
