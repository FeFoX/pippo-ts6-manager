package main

import "sync"

// ffmpeg's VP9 RTP packetizer writes a one-byte payload descriptor (0x08: only "start of frame")
// on every packet of every frame. A WebRTC receiver reads that as: no picture id, and no frame
// is predicted from another, so every frame is a keyframe. The receiver then tracks no
// references: after a lost packet it decodes the frames that follow against a missing
// reference, the picture breaks up or freezes, and nothing tells it to ask for a keyframe.
//
// vp9Descriptor rewrites the descriptor of a copied VP9 video the way libwebrtc's own sender
// writes it for one spatial and one temporal layer (draft-ietf-payload-vp9, non-flexible mode):
// a 15-bit picture id, the "inter-picture predicted" bit set on every frame but a keyframe, a
// layer byte and TL0PICIDX, and on keyframes the scalability structure that says every picture
// is predicted from the one before it.
const (
	vp9FlagI = 0x80 // picture id present
	vp9FlagP = 0x40 // inter-picture predicted
	vp9FlagL = 0x20 // layer indices present
	vp9FlagF = 0x10 // flexible mode
	vp9FlagB = 0x08 // start of a frame
	vp9FlagE = 0x04 // end of a frame
	vp9FlagV = 0x02 // scalability structure present
	vp9FlagZ = 0x01 // not a reference for upper spatial layers
)

type vp9Descriptor struct {
	mu      sync.Mutex
	picID   uint16 // 15 bits, of the frame being sent
	tl0     uint8
	started bool // a frame has been seen since the last reset
	inFrame bool
	key     bool
}

// reset forgets the frame in progress (a new source starts). The counters go on, so a
// receiver sees one continuous sequence of picture ids across a seek.
func (d *vp9Descriptor) reset() {
	d.mu.Lock()
	d.inFrame = false
	d.mu.Unlock()
}

// vp9HeaderIsKeyframe reads the first byte of a VP9 frame: frame_marker (2 bits, 0b10), the
// profile (2 bits, plus a reserved bit for profile 3), show_existing_frame, then frame_type
// (0 = keyframe).
func vp9HeaderIsKeyframe(h byte) bool {
	if h>>6 != 0x2 {
		return false
	}
	profile := (h>>5)&0x1 | ((h>>4)&0x1)<<1
	bit := 4
	if profile == 3 {
		bit++
	}
	if (h>>(7-bit))&0x1 == 1 { // show_existing_frame: shows an earlier frame, decodes nothing new
		return false
	}
	bit++
	return (h>>(7-bit))&0x1 == 0
}

// rewrite returns payload with the descriptor replaced. last says the packet ends a frame (the
// RTP marker bit). A payload that does not look like ffmpeg's one-byte descriptor is returned
// unchanged, so a different packetizer is never made worse.
func (d *vp9Descriptor) rewrite(payload []byte, last bool) []byte {
	if len(payload) < 2 {
		return payload
	}
	b0 := payload[0]
	if b0&^(vp9FlagB|vp9FlagE) != 0 {
		return payload
	}
	start := b0&vp9FlagB != 0

	d.mu.Lock()
	defer d.mu.Unlock()
	if start {
		if d.started {
			d.picID = (d.picID + 1) & 0x7fff
			d.tl0++
		}
		d.started = true
		d.inFrame = true
		d.key = vp9HeaderIsKeyframe(payload[1])
	} else if !d.inFrame {
		// The middle of a frame whose start was not seen: nothing to attach it to.
		return payload
	}

	flags := byte(vp9FlagI | vp9FlagL)
	if !d.key {
		flags |= vp9FlagP
	}
	if start {
		flags |= vp9FlagB
	}
	if last {
		flags |= vp9FlagE
		d.inFrame = false
	}
	withStructure := start && d.key
	if withStructure {
		flags |= vp9FlagV
	}

	out := make([]byte, 0, len(payload)+8)
	out = append(out, flags)
	out = append(out, 0x80|byte(d.picID>>8), byte(d.picID)) // M bit + 15-bit picture id
	out = append(out, 0x10, d.tl0)                          // TID 0, U (up-switch), SID 0 | TL0PICIDX
	if withStructure {
		// SS: N_S=0 (one spatial layer), Y=0, G=1 | N_G=1 | picture 0: TID 0, U, R=1 | P_DIFF 1.
		out = append(out, 0x08, 0x01, 0x14, 0x01)
	}
	return append(out, payload[1:]...)
}
