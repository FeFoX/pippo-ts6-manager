package main

import (
	"bytes"
	"testing"
)

// First bytes of VP9 frames: profile 0, shown; 0x82 is a keyframe, 0x86 a predicted frame,
// 0x88 shows an existing frame.
const (
	vp9KeyHeader      = 0x82
	vp9InterHeader    = 0x86
	vp9ShowExistingHd = 0x88
)

func ffmpegPacket(start bool, header byte) []byte {
	d := byte(0)
	if start {
		d = vp9FlagB
	}
	return []byte{d, header, 0xAA, 0xBB, 0xCC}
}

func TestVP9HeaderIsKeyframe(t *testing.T) {
	cases := map[byte]bool{vp9KeyHeader: true, vp9InterHeader: false, vp9ShowExistingHd: false, 0x00: false, 0x42: false}
	for h, want := range cases {
		if got := vp9HeaderIsKeyframe(h); got != want {
			t.Errorf("header %#x: key=%v, want %v", h, got, want)
		}
	}
	// Profile 3 has one reserved bit before show_existing_frame: 10 1 1 0 | 0 | 0.
	if !vp9HeaderIsKeyframe(0b10110000) {
		t.Error("a profile 3 keyframe must be recognised")
	}
}

func TestVP9DescriptorMarksOnlyKeyframesAsKeyframes(t *testing.T) {
	d := &vp9Descriptor{}
	// A keyframe in three packets, then two predicted frames of one packet each.
	key1 := d.rewrite(ffmpegPacket(true, vp9KeyHeader), false)
	key2 := d.rewrite(ffmpegPacket(false, 0x11), false)
	key3 := d.rewrite(ffmpegPacket(false, 0x22), true)
	inter := d.rewrite(ffmpegPacket(true, vp9InterHeader), true)
	inter2 := d.rewrite(ffmpegPacket(true, vp9InterHeader), true)

	if key1[0] != vp9FlagI|vp9FlagL|vp9FlagB|vp9FlagV {
		t.Errorf("first keyframe packet: %#x", key1[0])
	}
	if key1[0]&vp9FlagP != 0 {
		t.Error("a keyframe must not be marked predicted")
	}
	if key2[0] != vp9FlagI|vp9FlagL || key3[0] != vp9FlagI|vp9FlagL|vp9FlagE {
		t.Errorf("middle %#x and last %#x packets of a keyframe", key2[0], key3[0])
	}
	if inter[0] != vp9FlagI|vp9FlagP|vp9FlagL|vp9FlagB|vp9FlagE {
		t.Errorf("a predicted frame in one packet: %#x", inter[0])
	}
	// Picture id and TL0PICIDX follow the frames, not the packets.
	picID := func(p []byte) int { return int(p[1]&0x7f)<<8 | int(p[2]) }
	if picID(key1) != picID(key3) || picID(inter) != picID(key1)+1 || picID(inter2) != picID(key1)+2 {
		t.Errorf("picture ids: %d %d %d %d %d", picID(key1), picID(key2), picID(key3), picID(inter), picID(inter2))
	}
	if key1[1]&0x80 == 0 {
		t.Error("the M bit must announce a 15-bit picture id")
	}
	if key1[4] != 0 || inter[4] != 1 || inter2[4] != 2 {
		t.Errorf("TL0PICIDX: %d %d %d", key1[4], inter[4], inter2[4])
	}
}

func TestVP9DescriptorKeepsTheFramePayloadAndAddsStructureToKeyframes(t *testing.T) {
	d := &vp9Descriptor{}
	key := d.rewrite(ffmpegPacket(true, vp9KeyHeader), true)
	// flags + picture id (2) + layer (2) + SS (4), then the original bytes after the descriptor.
	if want := []byte{0x08, 0x01, 0x14, 0x01}; !bytes.Equal(key[5:9], want) {
		t.Errorf("scalability structure: % x", key[5:9])
	}
	if !bytes.Equal(key[9:], []byte{vp9KeyHeader, 0xAA, 0xBB, 0xCC}) {
		t.Errorf("frame data must be untouched: % x", key[9:])
	}
	inter := d.rewrite(ffmpegPacket(true, vp9InterHeader), true)
	if len(inter) != 5+4 || !bytes.Equal(inter[5:], []byte{vp9InterHeader, 0xAA, 0xBB, 0xCC}) {
		t.Errorf("a predicted frame carries no structure: % x", inter)
	}
}

// A new viewer opens its gate on the first keyframe, so the rewritten packet must still be
// recognised by the code that does that, and a predicted frame must not be.
func TestRewrittenVP9PacketsStillOpenTheGateOnlyOnKeyframes(t *testing.T) {
	d := &vp9Descriptor{}
	if !isVP9KeyframeStart(d.rewrite(ffmpegPacket(true, vp9KeyHeader), true)) {
		t.Error("a rewritten keyframe must open the gate")
	}
	if isVP9KeyframeStart(d.rewrite(ffmpegPacket(true, vp9InterHeader), true)) {
		t.Error("a rewritten predicted frame must not open the gate")
	}
	if isVP9KeyframeStart(d.rewrite(ffmpegPacket(true, vp9ShowExistingHd), true)) {
		t.Error("show_existing_frame must not open the gate")
	}
}

func TestVP9DescriptorLeavesOtherPacketizersAlone(t *testing.T) {
	d := &vp9Descriptor{}
	for _, p := range [][]byte{
		{vp9FlagI | vp9FlagB, 0x80, 0x01, vp9KeyHeader}, // already has a picture id
		{vp9FlagL | vp9FlagB, 0x10, vp9KeyHeader},
		{vp9FlagV | vp9FlagB, vp9KeyHeader},
		{0x08},
	} {
		if got := d.rewrite(p, true); !bytes.Equal(got, p) {
			t.Errorf("% x must pass unchanged, got % x", p, got)
		}
	}
	// A packet from the middle of a frame whose start was never seen is not touched either.
	if got := d.rewrite(ffmpegPacket(false, 0x33), false); !bytes.Equal(got, ffmpegPacket(false, 0x33)) {
		t.Errorf("an orphan packet must pass unchanged: % x", got)
	}
}

func TestVP9DescriptorCountersContinueAcrossAReset(t *testing.T) {
	d := &vp9Descriptor{}
	d.rewrite(ffmpegPacket(true, vp9KeyHeader), true)
	a := d.rewrite(ffmpegPacket(true, vp9InterHeader), true)
	d.reset() // a seek starts a new ffmpeg
	b := d.rewrite(ffmpegPacket(true, vp9KeyHeader), true)
	if (int(b[1]&0x7f)<<8 | int(b[2])) != (int(a[1]&0x7f)<<8|int(a[2]))+1 {
		t.Errorf("picture ids must go on after a reset: % x then % x", a[:5], b[:5])
	}
	d.picID = 0x7fff
	wrapped := d.rewrite(ffmpegPacket(true, vp9InterHeader), true) // the next frame after 0x7fff
	if wrapped[1]&0x7f != 0 || wrapped[2] != 0 {
		t.Errorf("the picture id wraps at 15 bits: % x", wrapped[:3])
	}
}
