//go:build linux

package main

func copyToSystemClipboard(text string) error {
	commands := []clipboardCommand{
		{name: "wl-copy"},
		{name: "xclip", args: []string{"-selection", "clipboard"}},
		{name: "xsel", args: []string{"--clipboard", "--input"}},
	}
	return copyWithClipboardCommands(text, commands, runClipboardCommand)
}
