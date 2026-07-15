package main

import (
	"errors"
	"testing"

	"github.com/santifer/career-ops/dashboard/internal/ui/screens"
)

func TestCopyTextCmdWritesExactTextAndReportsSuccess(t *testing.T) {
	oldWriteSystemClipboard := writeSystemClipboard
	t.Cleanup(func() { writeSystemClipboard = oldWriteSystemClipboard })

	var copied string
	writeSystemClipboard = func(text string) error {
		copied = text
		return nil
	}

	cmd := copyTextCmd(screens.ViewerCopyTextMsg{
		Label: "Reach-out message",
		Text:  "Hello founder.",
	})
	result, ok := cmd().(screens.ViewerCopyResultMsg)
	if !ok {
		t.Fatalf("copy command returned %T, want ViewerCopyResultMsg", cmd())
	}
	if copied != "Hello founder." {
		t.Fatalf("clipboard received %q, want exact message text", copied)
	}
	if result.Label != "Reach-out message" || result.Err != nil {
		t.Fatalf("copy result = %#v, want successful reach-out result", result)
	}
	if result.Characters != 14 {
		t.Fatalf("copy result character count = %d, want 14", result.Characters)
	}
}

func TestCopyWithClipboardCommandsFallsBackAfterRuntimeFailure(t *testing.T) {
	commands := []clipboardCommand{
		{name: "wl-copy"},
		{name: "xclip", args: []string{"-selection", "clipboard"}},
	}
	var attempted []string
	run := func(candidate clipboardCommand, text string) error {
		attempted = append(attempted, candidate.name+":"+text)
		if candidate.name == "wl-copy" {
			return errors.New("Wayland display unavailable")
		}
		return nil
	}

	if err := copyWithClipboardCommands("Hello founder.", commands, run); err != nil {
		t.Fatalf("fallback clipboard command failed: %v", err)
	}
	want := []string{"wl-copy:Hello founder.", "xclip:Hello founder."}
	if len(attempted) != len(want) {
		t.Fatalf("attempted commands = %v, want %v", attempted, want)
	}
	for i := range want {
		if attempted[i] != want[i] {
			t.Fatalf("attempted commands = %v, want %v", attempted, want)
		}
	}
}
