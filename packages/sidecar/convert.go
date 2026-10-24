package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A direct stream copies the video it is given, which only works for some pictures (VP9, or
// H.264 without B-frames). When the picture cannot be copied the backend asks the sidecar to
// convert the whole video once, into H.264 without B-frames, and streams the result as it is.
// The conversion reads the source through the same egress policy as streaming it, and writes
// only a ".stream-<digits>.mp4" file in the music folder.

const (
	// convertTimeout is the longest one conversion may run.
	convertTimeout = 3 * time.Hour
	// convertKeepFinished is how long a finished job stays readable.
	convertKeepFinished = 10 * time.Minute
	// orphanStreamFileAge is how old a ".stream-*" file in the music folder must be before the
	// start-up sweep removes it. It is longer than a conversion may run, so the sweep never
	// touches a file that is still in use.
	orphanStreamFileAge = convertTimeout + time.Hour
)

var (
	convertOutputName = regexp.MustCompile(`^\.stream-[0-9]+\.mp4$`)
	// streamTempName also matches the ".part" file a conversion writes before it renames it.
	streamTempName = regexp.MustCompile(`^\.stream-[0-9]+\.mp4(\.part)?$`)
	convertBitrate = regexp.MustCompile(`^[0-9]{2,6}[kKmM]?$`)
	convertPresets = map[string]bool{"ultrafast": true, "superfast": true, "veryfast": true}
)

// ConvertRequest is one POST /convert call.
type ConvertRequest struct {
	Source string `json:"source"`
	// Output is "music://.stream-<digits>.mp4" or the same name bare.
	Output string `json:"output"`
	// Width and Height are the largest picture; a smaller one is never enlarged.
	Width  int `json:"width"`
	Height int `json:"height"`
	// Bitrate caps the video bitrate (VBV); quality is constant-rate (CRF) below it.
	Bitrate string `json:"bitrate"`
	// SourceBitrateKbps is the source's own video bitrate, 0 when not known. The cap is never
	// raised above it, so the converted file does not come out larger than its source.
	SourceBitrateKbps int `json:"sourceBitrateKbps"`
	// Threads is the manager's encode thread setting (0 = automatic). Without a conversion
	// setting, a conversion uses at most convertThreadsLimit of them, so a live stream sharing
	// the CPUs keeps its share.
	Threads int `json:"threads"`
	// ConvertThreads is the manager's convert thread setting (0 = automatic, see convertThreads).
	ConvertThreads int `json:"convertThreads"`
	// CPUPriority is normal, low or lowest (a nice value on ffmpeg); "" = VIDEO_CPU_PRIORITY, else normal.
	CPUPriority string `json:"cpuPriority"`
	Preset      string `json:"preset"`
	// Gop is the keyframe interval in frames: short, so that a viewer who joins late, or loses a
	// packet, gets a new picture within a second or so.
	Gop int `json:"gop"`
	// DurationSec of the source, for the progress figure; 0 = unknown.
	DurationSec  float64  `json:"durationSec"`
	AllowedHosts []string `json:"allowedHosts"`
}

// ConvertStatus is what GET /convert reports.
type ConvertStatus struct {
	ID    string `json:"id"`
	State string `json:"state"` // running, done, failed, cancelled
	// Percent is 0-100, or -1 when the length is unknown.
	Percent float64 `json:"percent"`
	// Speed is the conversion speed as a multiple of real time (0 = not known yet).
	Speed float64 `json:"speed"`
	Error string  `json:"error,omitempty"`
}

type convertJob struct {
	mu      sync.Mutex
	status  ConvertStatus
	cancel  context.CancelFunc
	part    string
	final   string
	doneAt  time.Time
	started time.Time
}

func (j *convertJob) snapshot() ConvertStatus {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.status
}

func (j *convertJob) update(f func(*ConvertStatus)) {
	j.mu.Lock()
	f(&j.status)
	j.mu.Unlock()
}

// finish ends a running job and reports whether it did; a job that already ended is left as it is.
func (j *convertJob) finish(state, msg string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.State != "running" {
		return false
	}
	j.status.State = state
	j.status.Error = msg
	if state == "done" {
		j.status.Percent = 100
	}
	j.doneAt = time.Now()
	return true
}

// validateConvert checks a request and resolves the output path in the music folder.
func validateConvert(req ConvertRequest) (source, final string, err error) {
	if req.Source == "" {
		return "", "", errors.New("source is required")
	}
	if source, err = resolveSource(req.Source); err != nil {
		return "", "", err
	}
	name := strings.TrimPrefix(req.Output, "music://")
	if !convertOutputName.MatchString(name) {
		return "", "", errors.New(`output must be a ".stream-<digits>.mp4" file`)
	}
	if req.Width < 64 || req.Width > 8192 || req.Height < 64 || req.Height > 8192 {
		return "", "", errors.New("width and height must be between 64 and 8192")
	}
	if !convertBitrate.MatchString(strings.TrimSpace(req.Bitrate)) {
		return "", "", errors.New("bitrate must look like 2500k")
	}
	if !convertPresets[req.Preset] {
		return "", "", errors.New("preset must be ultrafast, superfast or veryfast")
	}
	if req.SourceBitrateKbps < 0 || req.SourceBitrateKbps > 10_000_000 {
		return "", "", errors.New("sourceBitrateKbps must be between 0 and 10000000")
	}
	if req.Threads < 0 || req.Threads > maxEncodeThreads {
		return "", "", fmt.Errorf("threads must be between 0 and %d", maxEncodeThreads)
	}
	if req.ConvertThreads < 0 || req.ConvertThreads > maxEncodeThreads {
		return "", "", fmt.Errorf("convertThreads must be between 0 and %d", maxEncodeThreads)
	}
	if !validCPUPriority(req.CPUPriority) {
		return "", "", errors.New("cpuPriority must be normal, low or lowest")
	}
	if req.Gop < 1 || req.Gop > 300 {
		return "", "", errors.New("gop must be between 1 and 300 frames")
	}
	if math.IsNaN(req.DurationSec) || req.DurationSec < 0 || req.DurationSec > 86400 {
		return "", "", errors.New("durationSec must be between 0 and 86400")
	}
	return source, filepath.Join(getMusicDir(), name), nil
}

// convertMinBitrateKbps is the lowest cap a conversion is given, however small its source.
const convertMinBitrateKbps = 100

// convertMaxrate is the VBV cap of a conversion: the requested bitrate, lowered to the source's
// own video bitrate when that is known, so the file does not come out larger than its source.
func convertMaxrate(requested string, sourceKbps int) string {
	requested = strings.TrimSpace(requested)
	if sourceKbps <= 0 {
		return requested
	}
	kbps, ok := bitrateKbps(requested)
	if !ok || sourceKbps >= kbps {
		return requested
	}
	if sourceKbps < convertMinBitrateKbps {
		sourceKbps = convertMinBitrateKbps
	}
	return strconv.Itoa(sourceKbps) + "k"
}

// bitrateKbps reads "2500k", "2.5M" style values as kilobits per second; a bare number is bits per second
// as ffmpeg reads it.
func bitrateKbps(v string) (int, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	mult := 1.0 / 1000
	switch last := v[len(v)-1]; last {
	case 'k', 'K':
		mult, v = 1, v[:len(v)-1]
	case 'm', 'M':
		mult, v = 1000, v[:len(v)-1]
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return int(n * mult), true
}

// buildConvertArgs assembles the ffmpeg command line. input holds the options that belong to
// the input (the egress proxy for a remote source).
func buildConvertArgs(req ConvertRequest, source string, input []string, part string) []string {
	bitrate := convertMaxrate(req.Bitrate, req.SourceBitrateKbps)
	scale := fmt.Sprintf(
		"scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
		req.Width, req.Height,
	)
	gop := strconv.Itoa(req.Gop)
	args := []string{"-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-progress", "pipe:1", "-y"}
	args = append(args, input...)
	args = append(args,
		"-i", source,
		"-map", "0:v:0", "-map", "0:a:0?",
		"-vf", scale,
		// Constrained High: High profile without B-frames, the only H.264 the viewers render.
		"-c:v", "libx264", "-preset", req.Preset, "-profile:v", "high", "-bf", "0",
		// x264 starts about 1.5 threads per CPU it sees; unbounded it takes the CPUs a live
		// stream needs for as long as the conversion lasts.
		"-threads", strconv.Itoa(convertThreads(req.ConvertThreads, req.Threads)),
		"-g", gop, "-keyint_min", gop,
		"-crf", "24", "-maxrate", bitrate, "-bufsize", videoBufsize(bitrate),
		"-c:a", "aac", "-b:a", "128k", "-ac", "2",
		"-movflags", "+faststart",
		"-f", "mp4", part,
	)
	return args
}

// StartConvert starts one conversion. Only one runs at a time: it is CPU-heavy and the host is
// shared with the live stream.
func (s *Sidecar) StartConvert(req ConvertRequest) (ConvertStatus, error) {
	source, final, err := validateConvert(req)
	if err != nil {
		return ConvertStatus{}, err
	}

	s.convertMu.Lock()
	defer s.convertMu.Unlock()
	if s.convert != nil {
		if st := s.convert.snapshot(); st.State == "running" {
			return ConvertStatus{}, errConvertBusy
		}
	}

	var input []string
	var env []string
	var proxy *egressProxy
	if isRemoteSource(source) {
		if egressEnabled() {
			proxy, err = startEgressProxy(&egressPolicy{allow: parseHostAllowlist(req.AllowedHosts)})
			if err != nil {
				return ConvertStatus{}, fmt.Errorf("start egress proxy: %w", err)
			}
			input = append(input, egressInputArgs(proxy.URL())...)
			env = egressCommandEnv()
		}
		input = append(input, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5")
		input = append(input, remoteFFmpegInputArgs()...)
	}

	var idb [6]byte
	_, _ = rand.Read(idb[:])
	ctx, cancel := context.WithTimeout(context.Background(), convertTimeout)
	job := &convertJob{
		status:  ConvertStatus{ID: hex.EncodeToString(idb[:]), State: "running", Percent: -1},
		cancel:  cancel,
		part:    final + ".part",
		final:   final,
		started: time.Now(),
	}
	if req.DurationSec > 0 {
		job.status.Percent = 0
	}
	args := buildConvertArgs(req, source, input, job.part)
	cmd := exec.CommandContext(ctx, getFfmpegPath(), args...)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		if proxy != nil {
			proxy.Close()
		}
		return ConvertStatus{}, err
	}
	stderr := &tailBuffer{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		cancel()
		if proxy != nil {
			proxy.Close()
		}
		return ConvertStatus{}, fmt.Errorf("start ffmpeg: %w", err)
	}
	applyCPUPriority(cmd, resolveCPUPriority(req.CPUPriority))
	s.convert = job
	log.Printf("[Convert %s] started: preset=%s max %dx%d bitrate=%s gop=%d remote=%v", job.status.ID, req.Preset, req.Width, req.Height, req.Bitrate, req.Gop, isRemoteSource(source))

	go func() {
		defer cancel()
		if proxy != nil {
			defer proxy.Close()
		}
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			key, val, ok := strings.Cut(sc.Text(), "=")
			if !ok {
				continue
			}
			switch key {
			case "out_time_us", "out_time_ms":
				// Both are microseconds (out_time_ms is a long-standing misnomer).
				if us, perr := strconv.ParseFloat(val, 64); perr == nil && us >= 0 && req.DurationSec > 0 {
					p := us / 1e6 / req.DurationSec * 100
					job.update(func(st *ConvertStatus) { st.Percent = math.Min(99.9, p) })
				}
			case "speed":
				if f, perr := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(val), "x"), 64); perr == nil {
					job.update(func(st *ConvertStatus) { st.Speed = f })
				}
			}
		}
		werr := cmd.Wait()
		switch {
		case ctx.Err() != nil && job.snapshot().State == "cancelled":
			_ = os.Remove(job.part)
		case werr != nil:
			_ = os.Remove(job.part)
			reason := stderr.summary()
			if reason == "" {
				reason = werr.Error()
			}
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				reason = "conversion took longer than " + convertTimeout.String()
			}
			job.finish("failed", reason)
			log.Printf("[Convert %s] failed: %s", job.status.ID, reason)
		default:
			if rerr := os.Rename(job.part, job.final); rerr != nil {
				_ = os.Remove(job.part)
				job.finish("failed", rerr.Error())
				return
			}
			job.finish("done", "")
			log.Printf("[Convert %s] done in %s", job.status.ID, time.Since(job.started).Round(time.Second))
		}
	}()
	return job.snapshot(), nil
}

var errConvertBusy = errors.New("another conversion is running")

// ConvertStatusFor reports a job by id; ok is false for an unknown or expired one.
func (s *Sidecar) ConvertStatusFor(id string) (ConvertStatus, bool) {
	s.convertMu.Lock()
	defer s.convertMu.Unlock()
	if s.convert == nil || s.convert.snapshot().ID != id {
		return ConvertStatus{}, false
	}
	st := s.convert.snapshot()
	s.convert.mu.Lock()
	expired := st.State != "running" && time.Since(s.convert.doneAt) > convertKeepFinished
	s.convert.mu.Unlock()
	if expired {
		s.convert = nil
		return ConvertStatus{}, false
	}
	return st, true
}

// CancelConvert stops a running job and discards its partial output. It reports false for an
// unknown job and for one that had already ended.
func (s *Sidecar) CancelConvert(id string) bool {
	s.convertMu.Lock()
	job := s.convert
	s.convertMu.Unlock()
	if job == nil || job.snapshot().ID != id {
		return false
	}
	// A job that already ended was not cancelled, and its output is not discarded here.
	if !job.finish("cancelled", "") {
		return false
	}
	job.cancel()
	return true
}

// sweepOrphanStreamFiles removes the ".stream-<digits>.mp4" and ".stream-<digits>.mp4.part"
// files a restart left behind (a conversion that was running, or finished for a start that was
// abandoned) and that are older than maxAge. It returns the names it removed.
func sweepOrphanStreamFiles(dir string, maxAge time.Duration, now time.Time) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var removed []string
	for _, e := range entries {
		if e.IsDir() || !streamTempName.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() || now.Sub(info.ModTime()) < maxAge {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err == nil {
			removed = append(removed, e.Name())
		}
	}
	return removed
}
