package main

import (
	"errors"
	"log"
	"os"
	"strconv"
	"strings"
)

// Use the HTTP protocol's Connection header rather than an HLS-only
// demuxer option. FFmpeg propagates headers to playlists and segments, so
// opaque URLs and redirects work without probing or guessing the format.

const (
	httpPersistentAuto = "auto"
	httpPersistentOff  = "0" // request a fresh connection for remote HTTP inputs
	httpPersistentOn   = "1" // leave FFmpeg's own default alone
)

func httpPersistentMode() string {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("FFMPEG_HTTP_PERSISTENT"))) {
	case "", httpPersistentAuto:
		return httpPersistentAuto
	case httpPersistentOff, "off", "false", "no":
		return httpPersistentOff
	case httpPersistentOn, "on", "true", "yes":
		return httpPersistentOn
	default:
		log.Printf("[FFmpeg] Unrecognized FFMPEG_HTTP_PERSISTENT value; using auto")
		return httpPersistentAuto
	}
}

// remoteFFmpegInputArgs applies the same HTTP settings to playback and probing.
// Preserve custom headers, but manage Connection through FFMPEG_HTTP_PERSISTENT.
func remoteFFmpegInputArgs() []string {
	args := extraFFmpegArgs("FFMPEG_EXTRA_INPUT_ARGS")
	if httpPersistentMode() == httpPersistentOn {
		return args
	}
	headerIndex := -1
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-headers" {
			headerIndex = i + 1
		}
	}
	headers := ""
	if headerIndex >= 0 {
		for _, line := range strings.Split(args[headerIndex], "\n") {
			line = strings.TrimSuffix(line, "\r")
			name, _, _ := strings.Cut(line, ":")
			if strings.TrimSpace(line) != "" && !strings.EqualFold(strings.TrimSpace(name), "Connection") {
				headers += line + "\r\n"
			}
		}
	}
	headers += "Connection: close\r\n"
	if headerIndex >= 0 {
		args[headerIndex] = headers
		return args
	}
	return append(args, "-headers", headers)
}

// defaultThreadQueueSize is how many packets ffmpeg's demuxer thread may read ahead of the
// pace the stream is played at.
//
// With more than one input (a video and its separate audio, as for YouTube), ffmpeg reads each
// input in a thread of its own and hands the packets to the main loop through a queue, which
// holds only 8 packets by default: well under a second of video. -re waits in the main loop, so
// a demuxer that stops to open the next HLS segment (a playlist reload and a fetch, each on a
// new connection, which over a slow link takes half a second or more) runs the queue dry, and the
// output freezes. A deeper queue lets the demuxer read seconds ahead, so that fetch overlaps
// with playing what is already queued.
const defaultThreadQueueSize = 512

// threadQueueArgs is -thread_queue_size for one remote ffmpeg input. FFMPEG_THREAD_QUEUE_SIZE
// changes it (0 leaves ffmpeg's own default). It is an ffmpeg-only option, so it is not part of
// remoteFFmpegInputArgs, which ffprobe shares.
func threadQueueArgs() []string {
	n := envIntOrDefault("FFMPEG_THREAD_QUEUE_SIZE", defaultThreadQueueSize)
	if n <= 0 {
		return nil
	}
	if n > 65536 {
		n = 65536
	}
	return []string{"-thread_queue_size", strconv.Itoa(n)}
}

// extraFFmpegOutputArgs is FFMPEG_EXTRA_OUTPUT_ARGS, inserted immediately
// before each RTP muxer.
func extraFFmpegOutputArgs() []string {
	return extraFFmpegArgs("FFMPEG_EXTRA_OUTPUT_ARGS")
}

func extraFFmpegArgs(envName string) []string {
	raw := strings.TrimSpace(os.Getenv(envName))
	if raw == "" {
		return nil
	}
	args, err := parseFFmpegArgs(raw)
	if err != nil {
		log.Printf("[FFmpeg] Ignoring %s: %v", envName, err)
		return nil
	}
	if err := validateExtraFFmpegArgs(args); err != nil {
		log.Printf("[FFmpeg] Ignoring %s: %v", envName, err)
		return nil
	}
	return args
}

// parseFFmpegArgs splits an argument string into argv without invoking a
// shell. Single quotes are literal. Inside double quotes, \r, \n, \t and \\
// expand so an HTTP header value can carry a real CRLF.
func parseFFmpegArgs(raw string) ([]string, error) {
	var args []string
	var b strings.Builder
	inSingle, inDouble, quoted := false, false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case inSingle:
			if c == '\'' {
				inSingle = false
				continue
			}
			b.WriteByte(c)
		case inDouble:
			if c == '\\' && i+1 < len(raw) {
				i++
				switch raw[i] {
				case 'n':
					b.WriteByte('\n')
				case 'r':
					b.WriteByte('\r')
				case 't':
					b.WriteByte('\t')
				default:
					b.WriteByte(raw[i])
				}
				continue
			}
			if c == '"' {
				inDouble = false
				continue
			}
			b.WriteByte(c)
		case c == '\'':
			inSingle = true
			quoted = true
		case c == '"':
			inDouble = true
			quoted = true
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if b.Len() > 0 || quoted {
				args = append(args, b.String())
				b.Reset()
				quoted = false
			}
		default:
			b.WriteByte(c)
		}
	}
	if inSingle || inDouble {
		return nil, errors.New("unbalanced quote")
	}
	if b.Len() > 0 || quoted {
		args = append(args, b.String())
	}
	return args, nil
}

func validateExtraFFmpegArgs(args []string) error {
	for _, token := range args {
		if token == "-i" {
			return errors.New("refusing -i because it would add another input")
		}
		if bareURLToken(token) {
			return errors.New("refusing a bare URL because it would add another input or output")
		}
	}
	return nil
}

func bareURLToken(token string) bool {
	scheme, rest, ok := strings.Cut(token, "://")
	if !ok || scheme == "" || rest == "" {
		return false
	}
	for _, r := range scheme {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '+' && r != '-' && r != '.' {
			return false
		}
	}
	return true
}
