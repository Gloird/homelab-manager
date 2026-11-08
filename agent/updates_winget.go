//go:build windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
)

type wingetUpgradePayload struct {
	Sources []struct {
		Packages []wingetUpgrade `json:"Packages"`
	} `json:"Sources"`
	Packages []wingetUpgrade `json:"Packages"`
	Upgrades []wingetUpgrade `json:"Upgrades"`
	Data     []wingetUpgrade `json:"Data"`
}

type wingetUpgrade struct {
	Name              string `json:"Name"`
	ID                string `json:"Id"`
	PackageIdentifier string `json:"PackageIdentifier"`
	Version           string `json:"Version"`
	AvailableVersion  string `json:"AvailableVersion"`
	Source            string `json:"Source"`
}

var wingetIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+._\-:]*$`)

func collectWingetUpdates(ctx context.Context) ([]WingetUpdate, error) {
	out, err := runWingetOutput(ctx, "list", "--upgrade-available", "--accept-source-agreements", "--disable-interactivity", "--output", "json")
	if err != nil {
		text := strings.ToLower(string(out))
		if wingetOutputUnsupportedArg(string(out)) {
			return collectWingetUpdatesText(ctx)
		}
		if strings.Contains(text, "no installed package found matching input criteria") || strings.Contains(text, "aucun package installé") {
			return []WingetUpdate{}, nil
		}
		return nil, err
	}
	var data wingetUpgradePayload
	if err := json.Unmarshal(out, &data); err != nil {
		return collectWingetUpdatesText(ctx)
	}
	seen := map[string]bool{}
	outItems := []WingetUpdate{}
	add := func(p wingetUpgrade) {
		id := strings.TrimSpace(p.PackageIdentifier)
		if id == "" {
			id = strings.TrimSpace(p.ID)
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = id
		}
		if id == "" && name == "" {
			return
		}
		key := strings.ToLower(id + "\x00" + name)
		if seen[key] {
			return
		}
		seen[key] = true
		outItems = append(outItems, WingetUpdate{
			ID:        id,
			Name:      name,
			Current:   strings.TrimSpace(p.Version),
			Available: strings.TrimSpace(p.AvailableVersion),
			Source:    strings.TrimSpace(p.Source),
		})
	}
	for _, src := range data.Sources {
		for _, p := range src.Packages {
			add(p)
		}
	}
	for _, p := range data.Packages {
		add(p)
	}
	for _, p := range data.Upgrades {
		add(p)
	}
	for _, p := range data.Data {
		add(p)
	}
	sort.Slice(outItems, func(i, j int) bool {
		if outItems[i].Name != outItems[j].Name {
			return outItems[i].Name < outItems[j].Name
		}
		return outItems[i].ID < outItems[j].ID
	})
	return outItems, nil
}

func collectWingetUpdatesText(ctx context.Context) ([]WingetUpdate, error) {
	out, err := runWingetOutput(ctx, "list", "--upgrade-available", "--accept-source-agreements", "--disable-interactivity")
	if err != nil {
		text := strings.ToLower(string(out))
		if strings.Contains(text, "no installed package found matching input criteria") || strings.Contains(text, "aucun package installé") {
			return []WingetUpdate{}, nil
		}
		return nil, err
	}
	rows := parseWingetTable(string(out))
	if len(rows) == 0 {
		return []WingetUpdate{}, nil
	}
	seen := map[string]bool{}
	outItems := []WingetUpdate{}
	for _, r := range rows {
		id := strings.TrimSpace(r["id"])
		name := strings.TrimSpace(r["name"])
		if name == "" {
			name = id
		}
		if id == "" {
			id = name
		}
		if id == "" || isWingetSummaryLine(id) || isWingetSummaryLine(name) {
			continue
		}
		key := strings.ToLower(id + "\x00" + name)
		if seen[key] {
			continue
		}
		seen[key] = true
		outItems = append(outItems, WingetUpdate{
			ID:        id,
			Name:      name,
			Current:   strings.TrimSpace(r["version"]),
			Available: strings.TrimSpace(r["available"]),
			Source:    strings.TrimSpace(r["source"]),
		})
	}
	sort.Slice(outItems, func(i, j int) bool {
		if outItems[i].Name != outItems[j].Name {
			return outItems[i].Name < outItems[j].Name
		}
		return outItems[i].ID < outItems[j].ID
	})
	return outItems, nil
}

func runWingetUpgrade(ctx context.Context, emit func(string), ids []string) (int, error) {
	winget := wingetPath()
	if winget == "" {
		return -1, exec.ErrNotFound
	}
	base := []string{"upgrade", "--silent", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"}
	if len(ids) == 0 {
		return runStreaming(ctx, nil, emit, winget, append(base, "--all")...)
	}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || isWingetSummaryLine(id) {
			continue
		}
		if !wingetIDRe.MatchString(id) {
			return -1, fmt.Errorf("invalid winget id %q", id)
		}
		emit(fmt.Sprintf("winget upgrade %s\n", id))
		code, err := runStreaming(ctx, nil, emit, winget, append(base, "--id", id, "--exact")...)
		if err != nil || code != 0 {
			return code, err
		}
	}
	return 0, nil
}
