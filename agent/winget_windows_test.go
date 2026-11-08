//go:build windows

package main

import "testing"

func TestParseWingetTableSkipsSummaryLine(t *testing.T) {
	out := `
Name             Id                  Version        Available       Source
----             --                  -------        ---------       ------
Microsoft Edge   Microsoft.Edge      131.0.2903.86  131.0.2903.86    winget
6 upgrades available.
`
	rows := parseWingetTable(out)
	if len(rows) != 1 {
		t.Fatalf("expected 1 package row, got %d: %#v", len(rows), rows)
	}
	if rows[0]["id"] != "Microsoft.Edge" {
		t.Fatalf("expected package id to be kept, got %#v", rows[0])
	}
}

func TestRunWingetUpgradeSkipsSummaryString(t *testing.T) {
	if isWingetSummaryLine("6 upgrades available.") == false {
		t.Fatal("summary line should be filtered")
	}
	if isWingetSummaryLine("Microsoft.Edge") {
		t.Fatal("package id should not look like a summary line")
	}
}
