package main

import "testing"

func TestParseCgroupV2CPUMax(t *testing.T) {
	cases := map[string]int{
		"max 100000":    0,
		"300000 100000": 3,
		"250000 100000": 3, // 2.5 CPUs round up
		"50000 100000":  1, // a fraction of a CPU is still one thread
		"":              0,
		"garbage":       0,
		"100000 0":      0,
	}
	for in, want := range cases {
		if got := parseCgroupV2CPUMax(in); got != want {
			t.Errorf("parseCgroupV2CPUMax(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseCgroupV1CPU(t *testing.T) {
	if got := parseCgroupV1CPU("300000\n", "100000\n"); got != 3 {
		t.Errorf("quota 3 CPUs: got %d", got)
	}
	if got := parseCgroupV1CPU("-1", "100000"); got != 0 {
		t.Errorf("no quota: got %d", got)
	}
	if got := parseCgroupV1CPU("100000", ""); got != 0 {
		t.Errorf("unreadable period: got %d", got)
	}
}

func TestEncodeThreadsPrecedence(t *testing.T) {
	t.Setenv("VIDEO_ENCODE_THREADS", "")
	if got := encodeThreads(0); got < 1 || got > usableCPUs() {
		t.Errorf("default threads %d outside 1..%d", got, usableCPUs())
	}
	t.Setenv("VIDEO_ENCODE_THREADS", "5")
	if got := encodeThreads(0); got != 5 {
		t.Errorf("env should apply, got %d", got)
	}
	if got := encodeThreads(2); got != 2 {
		t.Errorf("the request should win over the env, got %d", got)
	}
}

func TestConvertThreadsAreCapped(t *testing.T) {
	t.Setenv("VIDEO_CONVERT_THREADS", "")
	t.Setenv("VIDEO_ENCODE_THREADS", "6")
	if got := convertThreads(0, 0); got != 2 {
		t.Errorf("conversion should be capped at 2, got %d", got)
	}
	t.Setenv("VIDEO_ENCODE_THREADS", "1")
	if got := convertThreads(0, 0); got != 1 {
		t.Errorf("conversion should not exceed the encode threads, got %d", got)
	}
	if got := convertThreads(0, 5); got != 2 {
		t.Errorf("the encode threads setting is capped too, got %d", got)
	}
}

func TestConvertThreadsPrecedenceIsSettingThenEnvThenDefault(t *testing.T) {
	t.Setenv("VIDEO_ENCODE_THREADS", "6")
	t.Setenv("VIDEO_CONVERT_THREADS", "4")
	if got := convertThreads(0, 0); got != 4 {
		t.Errorf("VIDEO_CONVERT_THREADS should apply without a setting, got %d", got)
	}
	if got := convertThreads(3, 0); got != 3 {
		t.Errorf("the Convert threads setting should win over the env, got %d", got)
	}
	// An explicit setting is the admin's choice and is not held to the default cap.
	t.Setenv("VIDEO_CONVERT_THREADS", "")
	if got := convertThreads(5, 1); got != 5 {
		t.Errorf("the setting is not capped, got %d", got)
	}
}
