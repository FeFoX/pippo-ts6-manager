package main

import (
	"testing"
	"time"
)

func TestNewVideoPacerIsNilWhenOff(t *testing.T) {
	for _, f := range []float64{0, -1, 0.5} {
		if newVideoPacer(f) != nil {
			t.Fatalf("factor %v must turn pacing off", f)
		}
	}
	if newVideoPacer(2.5) == nil {
		t.Fatal("factor 2.5 must pace")
	}
}

// A keyframe of 250 packets written in the same instant leaves spread over time, in order,
// and no packet is held for longer than the backlog cap.
func TestPacerSpreadsAKeyframeBurst(t *testing.T) {
	p := newVideoPacer(2.5)
	now := time.Unix(1000, 0)
	var waits []time.Duration
	for i := 0; i < 250; i++ {
		waits = append(waits, p.delay(1200, now))
	}
	for i := 0; i < pacerBurst; i++ {
		if waits[i] != 0 {
			t.Fatalf("the first %d packets go at once, packet %d waited %v", pacerBurst, i, waits[i])
		}
	}
	for i := 1; i < len(waits); i++ {
		if waits[i] < waits[i-1] {
			t.Fatalf("waits must not shrink inside a burst: %v then %v at %d", waits[i-1], waits[i], i)
		}
	}
	last := waits[len(waits)-1]
	// 246 packets at 2.5 x 3 Mbps = 937500 B/s: 1.28 ms apart, about 315 ms in all.
	if last < 250*time.Millisecond || last > pacerMaxBacklog {
		t.Fatalf("a 250-packet keyframe should be spread over about 0.3 s, last packet waited %v", last)
	}
	gap := waits[200] - waits[199]
	if gap < time.Millisecond || gap > 2*time.Millisecond {
		t.Fatalf("packets should leave about 1.3 ms apart, got %v", gap)
	}
}

// Past the cap the rest goes at once, so the picture cannot fall further behind.
func TestPacerNeverHoldsLongerThanTheBacklogCap(t *testing.T) {
	p := newVideoPacer(1)
	now := time.Unix(2000, 0)
	for i := 0; i < 2000; i++ {
		if w := p.delay(1200, now); w > pacerMaxBacklog {
			t.Fatalf("packet %d waited %v, more than the cap", i, w)
		}
	}
}

// After a pause the bucket has emptied: the next frame is not held back for the last one.
func TestPacerForgetsAnIdleMoment(t *testing.T) {
	p := newVideoPacer(2.5)
	now := time.Unix(3000, 0)
	for i := 0; i < 100; i++ {
		p.delay(1200, now)
	}
	later := now.Add(2 * time.Second)
	for i := 0; i < pacerBurst; i++ {
		if w := p.delay(1200, later); w != 0 {
			t.Fatalf("packet %d after a pause waited %v", i, w)
		}
	}
}

// The rate follows the video: a faster stream is paced faster.
func TestPacerRateFollowsTheMeasuredBitrate(t *testing.T) {
	slow, fast := newVideoPacer(2.5), newVideoPacer(2.5)
	start := time.Unix(4000, 0)
	for sec := 0; sec < 6; sec++ {
		now := start.Add(time.Duration(sec) * time.Second)
		for i := 0; i < 100; i++ {
			slow.delay(1200, now.Add(time.Duration(i)*10*time.Millisecond)) // 120 kB/s
			for j := 0; j < 5; j++ {
				fast.delay(1200, now.Add(time.Duration(i)*10*time.Millisecond)) // 600 kB/s
			}
		}
	}
	if fast.rate < 3*slow.rate {
		t.Fatalf("measured rates should differ by about 5x: slow %.0f fast %.0f", slow.rate, fast.rate)
	}
}
