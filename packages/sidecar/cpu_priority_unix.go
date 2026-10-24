//go:build !windows

package main

import (
	"log"
	"os/exec"
	"syscall"
)

// applyCPUPriority lowers the priority of a started ffmpeg. Raising a nice value needs no
// privilege. Threads ffmpeg starts later (the encoder's) inherit it from the main thread.
func applyCPUPriority(cmd *exec.Cmd, priority string) {
	nice := niceFor(priority)
	if nice == 0 || cmd == nil || cmd.Process == nil {
		return
	}
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, nice); err != nil {
		log.Printf("[FFmpeg] Could not set the CPU priority to %s: %v", describeNice(priority), err)
	}
}
