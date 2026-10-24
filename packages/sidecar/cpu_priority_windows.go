//go:build windows

package main

import "os/exec"

// applyCPUPriority does nothing on Windows: the setting is a Unix nice value.
func applyCPUPriority(_ *exec.Cmd, _ string) {}
