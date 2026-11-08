//go:build windows

package main

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
)

type rawWindowsUpdate struct {
	Title           string   `json:"Title"`
	KBArticleIDs    []string `json:"KBArticleIDs"`
	MaxDownloadSize int64    `json:"MaxDownloadSize"`
	MsrcSeverity    string   `json:"MsrcSeverity"`
}

func collectWindowsUpdates(ctx context.Context) ([]WindowsUpdate, error) {
	out, err := powershellJSON(ctx, windowsUpdatesQueryScript)
	if err != nil {
		return nil, err
	}
	var raw []rawWindowsUpdate
	if len(out) == 0 || string(out) == "null" {
		return []WindowsUpdate{}, nil
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		var one rawWindowsUpdate
		if err2 := json.Unmarshal(out, &one); err2 != nil {
			return nil, err
		}
		raw = []rawWindowsUpdate{one}
	}
	items := make([]WindowsUpdate, 0, len(raw))
	for _, u := range raw {
		kb := ""
		for _, x := range u.KBArticleIDs {
			if strings.TrimSpace(x) != "" {
				kb = strings.TrimSpace(x)
				break
			}
		}
		items = append(items, WindowsUpdate{
			Title:       strings.TrimSpace(u.Title),
			KBArticleID: kb,
			Size:        u.MaxDownloadSize,
			Severity:    strings.TrimSpace(u.MsrcSeverity),
		})
	}
	return items, nil
}

func runWindowsUpdateInstall(ctx context.Context, emit func(string)) (int, error) {
	return runStreaming(ctx, nil, emit, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsUpdateInstallScript)
}

func powershellJSON(ctx context.Context, script string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return []byte(strings.TrimSpace(string(out))), nil
}

const windowsUpdatesQueryScript = `
$ErrorActionPreference = 'Stop'
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
$items = @()
for ($i = 0; $i -lt $result.Updates.Count; $i++) {
  $u = $result.Updates.Item($i)
  $items += [PSCustomObject]@{
    Title = $u.Title
    KBArticleIDs = @($u.KBArticleIDs)
    MaxDownloadSize = [int64]$u.MaxDownloadSize
    MsrcSeverity = $u.MsrcSeverity
  }
}
$items | ConvertTo-Json -Compress
`

const windowsUpdateInstallScript = `
$ErrorActionPreference = 'Stop'
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
$updates = New-Object -ComObject Microsoft.Update.UpdateColl
for ($i = 0; $i -lt $result.Updates.Count; $i++) {
  $u = $result.Updates.Item($i)
  if (-not $u.EulaAccepted) { $u.AcceptEula() }
  [void]$updates.Add($u)
}
if ($updates.Count -eq 0) {
  Write-Output "No pending Windows updates."
  exit 0
}
$downloader = $session.CreateUpdateDownloader()
$downloader.Updates = $updates
$downloadResult = $downloader.Download()
Write-Output ("DownloadResult={0}" -f $downloadResult.ResultCode)
$installer = $session.CreateUpdateInstaller()
$installer.Updates = $updates
$installResult = $installer.Install()
Write-Output ("InstallResult={0}" -f $installResult.ResultCode)
Write-Output ("RebootRequired={0}" -f $installResult.RebootRequired)
for ($i = 0; $i -lt $updates.Count; $i++) {
  $u = $updates.Item($i)
  $r = $installResult.GetUpdateResult($i)
  Write-Output ("[{0}] {1} => {2}" -f $r.ResultCode, $u.Title, $r.HResult)
}
if ($installResult.ResultCode -gt 3) { exit 1 }
exit 0
`
