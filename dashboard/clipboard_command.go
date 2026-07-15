package main

import (
	"fmt"
	"os/exec"
	"strings"
)

type clipboardCommand struct {
	name string
	args []string
}

func copyWithClipboardCommands(
	text string,
	commands []clipboardCommand,
	run func(clipboardCommand, string) error,
) error {
	var failures []string
	for _, candidate := range commands {
		if err := run(candidate, text); err == nil {
			return nil
		} else {
			failures = append(failures, candidate.name+": "+err.Error())
		}
	}
	return fmt.Errorf("clipboard commands failed: %s", strings.Join(failures, "; "))
}

func runClipboardCommand(candidate clipboardCommand, text string) error {
	path, err := exec.LookPath(candidate.name)
	if err != nil {
		return err
	}
	cmd := exec.Command(path, candidate.args...)
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}
