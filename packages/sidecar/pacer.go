package main

import (
	"math"
	"sync"
	"time"
)

// A video sent as it is has frames of very different sizes: a keyframe is often ten times a
// predicted frame, and ffmpeg writes all of a frame's packets at once. Hundreds of packets
// leaving in the same instant overflow a queue on the way (the viewer's router, Wi-Fi), and
// the lost ones freeze the picture. The pacer spreads them out.
const (
	// pacerInitialRate is assumed until a second of the video has been measured: 3 Mbps.
	pacerInitialRate = 375_000.0
	// pacerFloorRate keeps a very low-bitrate video from being spread too thin: 1.5 Mbps.
	pacerFloorRate = 187_500.0
	// pacerBurst is how many packets may leave back to back after a quiet moment.
	pacerBurst = 4
	// pacerMaxBacklog bounds the delay pacing may add. A frame that would need longer goes
	// out at once for the rest, rather than letting the picture fall behind.
	pacerMaxBacklog = 600 * time.Millisecond
	pacerWindow     = time.Second
)

// videoPacer is a leaky bucket whose rate is a multiple of the video's own measured bitrate.
type videoPacer struct {
	mu       sync.Mutex
	factor   float64   // send rate as a multiple of the measured bitrate
	rate     float64   // measured bytes per second
	next     time.Time // when the bucket is empty again
	winStart time.Time
	winBytes int
}

// newVideoPacer returns nil when pacing is off (factor 0), so callers can skip it with one check.
func newVideoPacer(factor float64) *videoPacer {
	if math.IsNaN(factor) || factor < 1 {
		return nil
	}
	return &videoPacer{factor: math.Min(factor, 10), rate: pacerInitialRate}
}

// delay says how long a packet of size bytes arriving at now must wait before it is sent.
func (p *videoPacer) delay(size int, now time.Time) time.Duration {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.measure(size, now)
	rate := math.Max(p.rate*p.factor, pacerFloorRate)
	per := time.Duration(float64(size) / rate * float64(time.Second))

	// After a quiet moment the bucket is not empty but a few packets deep.
	if credit := per * pacerBurst; now.Sub(p.next) > credit {
		p.next = now.Add(-credit)
	}
	wait := p.next.Sub(now)
	if wait < 0 {
		wait = 0
	}
	if wait > pacerMaxBacklog {
		// Too far behind: send now and start over.
		p.next = now
		return 0
	}
	p.next = p.next.Add(per)
	return wait
}

// measure folds the packet into a one-second average of the video's bitrate.
func (p *videoPacer) measure(size int, now time.Time) {
	if p.winStart.IsZero() {
		p.winStart = now
	}
	p.winBytes += size
	if elapsed := now.Sub(p.winStart); elapsed >= pacerWindow {
		measured := float64(p.winBytes) / elapsed.Seconds()
		p.rate = 0.5*p.rate + 0.5*measured
		p.winStart = now
		p.winBytes = 0
	}
}

// paceLagWindow is the time constant of the average in paceLag: long enough that the audio
// follows the pacing delay of a keyframe smoothly instead of jumping with it.
const paceLagWindow = 2 * time.Second

// paceLag is the running average of the delay the pacer adds to the video. The pacer holds
// packets back after the sync layer has scheduled them, so the video reaches the viewers later
// than the audio sent for the same moment. Holding the audio back by the same average keeps the
// two close. It moves slowly (paceLagWindow), because audio packets are 20 ms apart and a lag
// that jumped would bunch them up.
type paceLag struct {
	mu    sync.Mutex
	value float64 // seconds
	last  time.Time
}

// observe folds in the delay d the pacer gave a video packet at now.
func (l *paceLag) observe(d time.Duration, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.last.IsZero() {
		if dt := now.Sub(l.last); dt > 0 {
			alpha := 1 - math.Exp(-dt.Seconds()/paceLagWindow.Seconds())
			l.value += alpha * (d.Seconds() - l.value)
		}
	}
	l.last = now
}

// current is the lag to add to the audio's send time.
func (l *paceLag) current() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.value < 0.001 {
		return 0
	}
	return time.Duration(l.value * float64(time.Second))
}

// reset forgets the average (a new source starts, or pacing is off).
func (l *paceLag) reset() {
	l.mu.Lock()
	l.value = 0
	l.last = time.Time{}
	l.mu.Unlock()
}
