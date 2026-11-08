//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/sys/windows/registry"
)

var wingetSepRe = regexp.MustCompile(`^\s*[-\s]{3,}\s*$`)

func wingetOutputUnsupportedArg(stderr string) bool {
	s := strings.ToLower(stderr)
	return strings.Contains(s, "--output") &&
		(strings.Contains(s, "not recognized") || strings.Contains(s, "n'a pas été reconnu") || strings.Contains(s, "n’a pas été reconnu"))
}

func wingetPath() string {
	if p, err := exec.LookPath("winget"); err == nil && p != "" {
		return p
	}
	if p := wingetRegistryPath(); p != "" {
		return p
	}
	if p := wingetWindowsAppsPath(); p != "" {
		return p
	}
	return ""
}

func runWingetOutput(ctx context.Context, args ...string) ([]byte, error) {
	if winget := wingetPath(); winget != "" {
		cmd := exec.CommandContext(ctx, winget, args...)
		out, err := cmd.CombinedOutput()
		if err == nil {
			return out, nil
		}
		if wingetOutputUnsupportedArg(string(out)) {
			return out, err
		}
		userOut, userErr := runWingetOutputAsActiveUser(ctx, args...)
		if userErr == nil {
			return userOut, nil
		}
		return out, errors.Join(fmt.Errorf("system winget failed: %w", err), userErr)
	}
	return runWingetOutputAsActiveUser(ctx, args...)
}

func runWingetProxy(args []string) error {
	winget := wingetPath()
	if winget == "" {
		return exec.ErrNotFound
	}
	cmd := exec.Command(winget, args...)
	out, err := cmd.CombinedOutput()
	if len(out) > 0 {
		_, _ = os.Stdout.Write(out)
	}
	if err != nil {
		return err
	}
	return nil
}

func wingetRegistryPath() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\winget.exe`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	if p, _, err := k.GetStringValue(""); err == nil {
		p = strings.TrimSpace(p)
		if p != "" {
			return p
		}
	}
	if p, _, err := k.GetStringValue("Path"); err == nil {
		p = filepath.Join(strings.TrimSpace(p), "winget.exe")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func wingetWindowsAppsPath() string {
	root := filepath.Join(os.Getenv("ProgramFiles"), "WindowsApps")
	if root == "" {
		return ""
	}
	pattern := filepath.Join(root, "Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe", "winget.exe")
	matches, _ := filepath.Glob(pattern)
	if len(matches) == 0 {
		return ""
	}
	sort.Strings(matches)
	return matches[len(matches)-1]
}

// parseWingetTable parses the plain-text table output of winget list/upgrade.
func parseWingetTable(out string) []map[string]string {
	lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")
	sep := -1
	for i, line := range lines {
		if wingetSepRe.MatchString(line) {
			sep = i
			break
		}
	}
	if sep < 1 {
		return nil
	}

	header := ""
	for i := sep - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			header = lines[i]
			break
		}
	}
	if header == "" {
		return nil
	}

	headerRunes := []rune(header)
	starts := []int{}
	for i, r := range headerRunes {
		if unicode.IsSpace(r) {
			continue
		}
		if i == 0 || unicode.IsSpace(headerRunes[i-1]) {
			starts = append(starts, i)
		}
	}
	if len(starts) < 2 {
		return nil
	}

	rows := []map[string]string{}
	for _, line := range lines[sep+1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		cols := []string{}
		runes := []rune(line)
		for i := 0; i < len(starts)-1; i++ {
			start, end := starts[i], starts[i+1]
			if start > len(runes) {
				cols = append(cols, "")
				continue
			}
			if end > len(runes) {
				end = len(runes)
			}
			cols = append(cols, strings.TrimSpace(string(runes[start:end])))
		}
		last := ""
		if starts[len(starts)-1] < len(runes) {
			last = strings.TrimSpace(string(runes[starts[len(starts)-1]:]))
		}
		cols = append(cols, last)
		empty := true
		for _, c := range cols {
			if c != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		row := map[string]string{
			"name":      "",
			"id":        "",
			"version":   "",
			"available": "",
			"source":    "",
		}
		if len(cols) > 0 {
			row["name"] = cols[0]
		}
		if len(cols) > 1 {
			row["id"] = cols[1]
		}
		if len(cols) > 2 {
			row["version"] = cols[2]
		}
		if len(cols) > 3 {
			row["available"] = cols[3]
		}
		if len(cols) > 4 {
			row["source"] = cols[4]
		}
		rows = append(rows, row)
	}
	return rows
}
