//go:build darwin

package main

func copyToSystemClipboard(text string) error {
	return copyWithClipboardCommands(text, []clipboardCommand{{name: "pbcopy"}}, runClipboardCommand)
}
