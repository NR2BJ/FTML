package translate

import (
	"strings"
	"testing"
)

func TestInvalidCueTimesAndTextEscaping(t *testing.T) {
	input := "WEBVTT\n\n00:70.000 --> 00:71.000\n잘못된 시간\n\n00:03.000 --> 00:02.000\n뒤집힌 시간\n\n00:01.000 --> 00:02.000\n&lt;안녕&gt; &amp; 친구\n"
	cues := ParseVTT(input)
	if len(cues) != 1 || cues[0].Text != "<안녕> & 친구" {
		t.Fatalf("%+v", cues)
	}
	out := CuesToVTT(cues)
	if !strings.Contains(out, "&lt;안녕&gt; &amp; 친구") {
		t.Fatal(out)
	}
	if got := ParseVTT(out); len(got) != 1 || got[0].Text != cues[0].Text || got[0].Start != 1 || got[0].End != 2 {
		t.Fatal(got)
	}
}
