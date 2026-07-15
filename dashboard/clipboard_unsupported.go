//go:build !windows && !darwin && !linux

package main

import (
	"fmt"
	"runtime"
)

func copyToSystemClipboard(string) error {
	return fmt.Errorf("clipboard copying is not supported on %s", runtime.GOOS)
}
