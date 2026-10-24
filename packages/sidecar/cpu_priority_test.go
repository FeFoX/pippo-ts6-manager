package main

import "testing"

func TestCPUPriorityLevelsAndFallback(t *testing.T) {
	t.Setenv("VIDEO_CPU_PRIORITY", "")
	for in, want := range map[string]int{"": 0, "normal": 0, "low": 10, "lowest": 19} {
		if got := niceFor(resolveCPUPriority(in)); got != want {
			t.Errorf("niceFor(resolveCPUPriority(%q)) = %d, want %d", in, got, want)
		}
	}
	if validCPUPriority("high") || validCPUPriority("LOW") {
		t.Error("only normal, low and lowest are levels")
	}
	t.Setenv("VIDEO_CPU_PRIORITY", "low")
	if got := resolveCPUPriority(""); got != "low" {
		t.Errorf("the env applies when the request names none, got %q", got)
	}
	if got := resolveCPUPriority("normal"); got != "normal" {
		t.Errorf("the request wins over the env, got %q", got)
	}
	t.Setenv("VIDEO_CPU_PRIORITY", "bogus")
	if got := resolveCPUPriority(""); got != "normal" {
		t.Errorf("an unknown env value is ignored, got %q", got)
	}
}
