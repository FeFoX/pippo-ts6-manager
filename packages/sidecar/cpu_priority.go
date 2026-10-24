package main

import (
	"fmt"
	"os"
	"strings"
)

// The manager's "CPU priority" setting lowers how much ffmpeg competes with the rest of the host
// (the web server, the TeamSpeak bots, other containers). It is the process's nice value.
const (
	cpuPriorityNormal = "normal"
	cpuPriorityLow    = "low"
	cpuPriorityLowest = "lowest"
)

// validCPUPriority reports whether p is one of the three levels; "" (not given) is valid.
func validCPUPriority(p string) bool {
	switch p {
	case "", cpuPriorityNormal, cpuPriorityLow, cpuPriorityLowest:
		return true
	}
	return false
}

// resolveCPUPriority picks the level for a request: the request's own, else
// VIDEO_CPU_PRIORITY, else normal.
func resolveCPUPriority(requested string) string {
	if requested != "" {
		return requested
	}
	if env := strings.ToLower(strings.TrimSpace(os.Getenv("VIDEO_CPU_PRIORITY"))); validCPUPriority(env) && env != "" {
		return env
	}
	return cpuPriorityNormal
}

// niceFor is the nice value of a level: 0 leaves ffmpeg alone, 10 is a clear step down, 19 only
// runs when nothing else wants the CPU.
func niceFor(priority string) int {
	switch priority {
	case cpuPriorityLow:
		return 10
	case cpuPriorityLowest:
		return 19
	}
	return 0
}

func describeNice(priority string) string {
	return fmt.Sprintf("%s (nice %d)", priority, niceFor(priority))
}
