//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"
)

func collectInstalledSoftware(ctx context.Context) (*InstalledSoftwareReport, error) {
	items, err := collectInstalledSoftwareWinget(ctx)
	if err == nil && len(items) > 0 {
		return &InstalledSoftwareReport{CheckedAt: time.Now().UnixMilli(), Items: items}, nil
	}
	reg, regErr := collectInstalledSoftwareRegistry()
	if regErr != nil {
		if err != nil {
			return nil, errors.Join(err, regErr)
		}
		return nil, regErr
	}
	if len(reg) == 0 && err != nil {
		return nil, err
	}
	return &InstalledSoftwareReport{CheckedAt: time.Now().UnixMilli(), Items: reg}, nil
}

type wingetListPayload struct {
	Sources []struct {
		Packages []wingetSoftware `json:"Packages"`
	} `json:"Sources"`
	Packages  []wingetSoftware `json:"Packages"`
	Installed []wingetSoftware `json:"Installed"`
	Data      []wingetSoftware `json:"Data"`
}

type wingetSoftware struct {
	Name              string `json:"Name"`
	Version           string `json:"Version"`
	Publisher         string `json:"Publisher"`
	PackageIdentifier string `json:"PackageIdentifier"`
	ID                string `json:"Id"`
}

func collectInstalledSoftwareWinget(ctx context.Context) ([]InstalledSoftware, error) {
	out, err := runWingetOutput(ctx, "list", "--accept-source-agreements", "--disable-interactivity", "--output", "json")
	if err != nil {
		if wingetOutputUnsupportedArg(string(out)) {
			return collectInstalledSoftwareWingetText(ctx)
		}
		return nil, err
	}
	var data wingetListPayload
	if err := json.Unmarshal(out, &data); err != nil {
		return collectInstalledSoftwareWingetText(ctx)
	}
	seen := map[string]bool{}
	items := []InstalledSoftware{}
	add := func(p wingetSoftware) {
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = strings.TrimSpace(p.PackageIdentifier)
		}
		if name == "" {
			name = strings.TrimSpace(p.ID)
		}
		if name == "" {
			return
		}
		item := InstalledSoftware{
			Name:      name,
			Version:   strings.TrimSpace(p.Version),
			Publisher: strings.TrimSpace(p.Publisher),
			Source:    "winget",
		}
		key := strings.ToLower(item.Name) + "\x00" + item.Version + "\x00" + strings.ToLower(item.Publisher)
		if seen[key] {
			return
		}
		seen[key] = true
		items = append(items, item)
	}
	for _, src := range data.Sources {
		for _, p := range src.Packages {
			add(p)
		}
	}
	for _, p := range data.Packages {
		add(p)
	}
	for _, p := range data.Installed {
		add(p)
	}
	for _, p := range data.Data {
		add(p)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Name != items[j].Name {
			return items[i].Name < items[j].Name
		}
		return items[i].Version < items[j].Version
	})
	return items, nil
}

func collectInstalledSoftwareWingetText(ctx context.Context) ([]InstalledSoftware, error) {
	out, err := runWingetOutput(ctx, "list", "--accept-source-agreements", "--disable-interactivity")
	if err != nil {
		return nil, err
	}
	rows := parseWingetTable(string(out))
	if len(rows) == 0 {
		return nil, fmt.Errorf("winget text output had no table rows")
	}
	seen := map[string]bool{}
	items := []InstalledSoftware{}
	for _, r := range rows {
		name := strings.TrimSpace(r["name"])
		if name == "" {
			name = strings.TrimSpace(r["id"])
		}
		if name == "" {
			continue
		}
		item := InstalledSoftware{
			Name:    name,
			Version: strings.TrimSpace(r["version"]),
			Source:  "winget",
		}
		key := strings.ToLower(item.Name) + "\x00" + item.Version
		if seen[key] {
			continue
		}
		seen[key] = true
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Name != items[j].Name {
			return items[i].Name < items[j].Name
		}
		return items[i].Version < items[j].Version
	})
	return items, nil
}

func collectInstalledSoftwareRegistry() ([]InstalledSoftware, error) {
	paths := []struct {
		root registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`},
		{registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
	}
	seen := map[string]bool{}
	items := []InstalledSoftware{}
	found := false
	for _, base := range paths {
		k, err := registry.OpenKey(base.root, base.path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		found = true
		names, err := k.ReadSubKeyNames(-1)
		if err == nil {
			for _, name := range names {
				sk, err := registry.OpenKey(k, name, registry.QUERY_VALUE)
				if err != nil {
					continue
				}
				display, _, _ := sk.GetStringValue("DisplayName")
				version, _, _ := sk.GetStringValue("DisplayVersion")
				publisher, _, _ := sk.GetStringValue("Publisher")
				systemComponent, _, _ := sk.GetIntegerValue("SystemComponent")
				releaseType, _, _ := sk.GetStringValue("ReleaseType")
				sk.Close()
				display = strings.TrimSpace(display)
				if display == "" || systemComponent == 1 || strings.EqualFold(strings.TrimSpace(releaseType), "Update") {
					continue
				}
				item := InstalledSoftware{
					Name:      display,
					Version:   strings.TrimSpace(version),
					Publisher: strings.TrimSpace(publisher),
					Source:    "registry",
				}
				key := strings.ToLower(item.Name) + "\x00" + item.Version + "\x00" + strings.ToLower(item.Publisher)
				if seen[key] {
					continue
				}
				seen[key] = true
				items = append(items, item)
			}
		}
		k.Close()
	}
	if !found {
		return nil, errors.New("windows uninstall registry keys not available")
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Name != items[j].Name {
			return items[i].Name < items[j].Name
		}
		return items[i].Version < items[j].Version
	})
	return items, nil
}
