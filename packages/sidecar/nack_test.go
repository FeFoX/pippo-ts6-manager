package main

import (
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// dropOnce is a viewer-side interceptor that loses one packet on the way in, before the
// viewer's own NACK generator sees the stream, like a packet lost on the network.
type dropOnce struct {
	interceptor.NoOp
	seq     uint16
	dropped bool
	mu      sync.Mutex
}

func (d *dropOnce) BindRemoteStream(info *interceptor.StreamInfo, reader interceptor.RTPReader) interceptor.RTPReader {
	if info.MimeType != webrtc.MimeTypeVP9 {
		return reader
	}
	return interceptor.RTPReaderFunc(func(b []byte, a interceptor.Attributes) (int, interceptor.Attributes, error) {
		for {
			n, attr, err := reader.Read(b, a)
			if err != nil {
				return n, attr, err
			}
			var h rtp.Header
			if _, perr := h.Unmarshal(b[:n]); perr == nil && h.SequenceNumber == d.seq {
				d.mu.Lock()
				first := !d.dropped
				d.dropped = true
				d.mu.Unlock()
				if first {
					continue // lost
				}
			}
			return n, attr, nil
		}
	})
}

type dropOnceFactory struct{ d *dropOnce }

func (f dropOnceFactory) NewInterceptor(string) (interceptor.Interceptor, error) { return f.d, nil }

var regexpFB = regexp.MustCompile(`a=rtcp-fb:96[^\r\n]*`)

func TestVideoOfferCarriesNackAndPli(t *testing.T) {
	t.Setenv("STUN_SERVERS", "")
	for _, codec := range []string{codecVP8, codecVP9, codecH264} {
		s := NewSidecar()
		offer, err := s.CreatePeer("fb-"+codec, codec)
		if err != nil {
			t.Fatalf("%s: %v", codec, err)
		}
		s.ClosePeer("fb-" + codec)
		for _, want := range []string{"a=rtcp-fb:96 nack\r\n", "a=rtcp-fb:96 nack pli\r\n"} {
			if !strings.Contains(offer, want) {
				t.Fatalf("%s offer must carry %q:\n%s", codec, want, offer)
			}
		}
	}
}

// A packet lost on the way to a viewer must be sent again when the viewer asks. Without it
// the picture stays frozen until the next keyframe, which a video sent as it is can take
// several seconds to reach.
func TestLostVideoPacketIsRetransmittedOnNack(t *testing.T) {
	t.Setenv("STUN_SERVERS", "")
	s := NewSidecar()
	offer, err := s.CreatePeer("nack", codecVP9)
	if err != nil {
		t.Fatalf("CreatePeer: %v", err)
	}
	defer s.ClosePeer("nack")

	const lost = 40
	d := &dropOnce{seq: lost}
	registry := &interceptor.Registry{}
	registry.Add(dropOnceFactory{d}) // first = closest to the network
	m := &webrtc.MediaEngine{}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeVP9, ClockRate: 90000, SDPFmtpLine: "profile-id=0", RTCPFeedback: videoFeedback,
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		PayloadType:        111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		t.Fatal(err)
	}
	if err := webrtc.RegisterDefaultInterceptors(m, registry); err != nil {
		t.Fatal(err)
	}
	// The test loses the packet after SRTP has decrypted it (an interceptor sits above SRTP), so the
	// viewer would drop the resent copy as a replay. A packet lost on a real network never reaches SRTP.
	se := webrtc.SettingEngine{}
	se.DisableSRTPReplayProtection(true)
	viewer, err := webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()

	var mu sync.Mutex
	got := map[uint16]int{}
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() != webrtc.RTPCodecTypeVideo {
			return
		}
		for {
			pkt, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			mu.Lock()
			got[pkt.SequenceNumber]++
			mu.Unlock()
		}
	})
	connected := make(chan struct{})
	var once sync.Once
	viewer.OnICEConnectionStateChange(func(st webrtc.ICEConnectionState) {
		if st == webrtc.ICEConnectionStateConnected {
			once.Do(func() { close(connected) })
		}
	})

	if err := viewer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		t.Fatalf("viewer rejected the offer: %v", err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(viewer)
	if err := viewer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err := s.SetAnswer("nack", viewer.LocalDescription().SDP); err != nil {
		t.Fatalf("SetAnswer: %v", err)
	}
	select {
	case <-connected:
	case <-time.After(10 * time.Second):
		t.Skip("no ICE connection between the two peers in this environment")
	}

	s.peersLock.RLock()
	track := s.peers["nack"].VideoTrack
	s.peersLock.RUnlock()
	for i := 0; i < 120; i++ {
		pkt := &rtp.Packet{
			Header:  rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: uint16(i), Timestamp: uint32(i * 3000), Marker: true},
			Payload: make([]byte, 200),
		}
		if err := track.WriteRTP(pkt); err != nil {
			t.Fatalf("WriteRTP: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := got[lost]
		mu.Unlock()
		if n > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	d.mu.Lock()
	dropped := d.dropped
	d.mu.Unlock()
	mu.Lock()
	t.Logf("viewer received %d distinct seqs; around the loss: %v", len(got), []int{got[38], got[39], got[40], got[41], got[42]})
	mu.Unlock()
	t.Logf("offer feedback lines: %q", regexpFB.FindAllString(offer, -1))
	t.Logf("answer feedback lines: %q", regexpFB.FindAllString(viewer.LocalDescription().SDP, -1))
	t.Fatalf("packet %d was never sent again (it was lost on the way: %v, retransmission requests seen by the sidecar: %d)",
		lost, dropped, s.rtcpNacks)
}
