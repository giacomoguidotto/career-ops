//go:build windows

package main

import (
	"os/exec"
	"strings"
)

func copyToSystemClipboard(text string) error {
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"[Console]::InputEncoding = [System.Text.UTF8Encoding]::new(); $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
	)
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}
