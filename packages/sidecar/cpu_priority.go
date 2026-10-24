package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
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

var warnBadPriorityEnv sync.Once

// resolveCPUPriority picks the level for a request: the request's own, else
// VIDEO_CPU_PRIORITY, else normal.
func resolveCPUPriority(requested string) string {
	if requested != "" {
		return requested
	}
	env := strings.ToLower(strings.TrimSpace(os.Getenv("VIDEO_CPU_PRIORITY")))
	if env == "" {
		return cpuPriorityNormal
	}
	if !validCPUPriority(env) {
		warnBadPriorityEnv.Do(func() {
			log.Printf("[FFmpeg] Ignoring VIDEO_CPU_PRIORITY=%q: use normal, low or lowest", os.Getenv("VIDEO_CPU_PRIORITY"))
		})
		return cpuPriorityNormal
	}
	return env
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
