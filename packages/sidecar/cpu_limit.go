package main

import (
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// runtime.NumCPU reports the CPUs the process may run on (its affinity), not the CPU time a
// container may use (the cgroup quota). A container capped at 3 CPUs on a 6-core host still
// reports 6, and ffmpeg given 6 encode threads inside a 3-CPU budget is throttled by the
// scheduler instead of encoding faster. usableCPUs reads the quota too.

const (
	cgroupV2CPUMax      = "/sys/fs/cgroup/cpu.max"
	cgroupV1CPUQuota    = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"
	cgroupV1CPUPeriod   = "/sys/fs/cgroup/cpu/cpu.cfs_period_us"
	convertThreadsLimit = 2
)

// parseCgroupV2CPUMax reads "<quota> <period>" or "max <period>" (cpu.max). It returns the
// quota as a number of CPUs, rounded up, or 0 when there is none.
func parseCgroupV2CPUMax(raw string) int {
	fields := strings.Fields(raw)
	if len(fields) < 1 || fields[0] == "max" {
		return 0
	}
	period := 100000.0
	if len(fields) >= 2 {
		p, err := strconv.ParseFloat(fields[1], 64)
		if err != nil || p <= 0 {
			return 0
		}
		period = p
	}
	quota, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || quota <= 0 {
		return 0
	}
	return int(math.Max(1, math.Ceil(quota/period)))
}

// parseCgroupV1CPU turns cpu.cfs_quota_us and cpu.cfs_period_us into a number of CPUs, rounded
// up. A quota of -1 means no limit (0 here).
func parseCgroupV1CPU(quotaRaw, periodRaw string) int {
	quota, err := strconv.ParseFloat(strings.TrimSpace(quotaRaw), 64)
	if err != nil || quota <= 0 {
		return 0
	}
	period, err := strconv.ParseFloat(strings.TrimSpace(periodRaw), 64)
	if err != nil || period <= 0 {
		return 0
	}
	return int(math.Max(1, math.Ceil(quota/period)))
}

// cgroupCPULimit is the CPU quota of this container in CPUs, or 0 when there is none or it
// cannot be read.
func cgroupCPULimit() int {
	if raw, err := os.ReadFile(cgroupV2CPUMax); err == nil {
		return parseCgroupV2CPUMax(string(raw))
	}
	quota, err := os.ReadFile(cgroupV1CPUQuota)
	if err != nil {
		return 0
	}
	period, err := os.ReadFile(cgroupV1CPUPeriod)
	if err != nil {
		return 0
	}
	return parseCgroupV1CPU(string(quota), string(period))
}

// usableCPUs is the smaller of the CPUs the process may run on and its cgroup quota.
func usableCPUs() int {
	n := runtime.NumCPU()
	if limit := cgroupCPULimit(); limit > 0 && limit < n {
		n = limit
	}
	if n < 1 {
		n = 1
	}
	return n
}

// encodeThreads is the -threads value for a software encode. A value of 1 or more from the
// request (the manager's "Encode threads" setting) wins, then VIDEO_ENCODE_THREADS, then the
// CPUs this container may really use.
func encodeThreads(requested int) int {
	if requested > 0 {
		return requested
	}
	if n := envIntOrDefault("VIDEO_ENCODE_THREADS", 0); n > 0 {
		return n
	}
	return usableCPUs()
}

// convertThreads caps the x264 conversion so that it cannot starve a live stream sharing the
// same CPUs. VIDEO_CONVERT_THREADS overrides; the default is two, or fewer when the
// encode threads are fewer.
func convertThreads(requested int) int {
	if n := envIntOrDefault("VIDEO_CONVERT_THREADS", 0); n > 0 {
		return n
	}
	n := encodeThreads(requested)
	if n > convertThreadsLimit {
		n = convertThreadsLimit
	}
	return n
}

// maxEncodeThreads is the most a request may ask for; libvpx and x264 stop scaling well before.
const maxEncodeThreads = 64

// clampThreads keeps a requested thread count usable: 0 (automatic) or 1 to maxEncodeThreads.
func clampThreads(n int) int {
	if n < 0 {
		return 0
	}
	if n > maxEncodeThreads {
		return maxEncodeThreads
	}
	return n
}
