//go:build windows

package main

// Messages of the Windows agent: the subset of protocol.go it uses, plus the sessions.

// A user session open on the host (console, fast user switching, remote desktop).
type Session struct {
	ID      uint32 `json:"id"`
	User    string `json:"user"`
	Domain  string `json:"domain,omitempty"`
	Station string `json:"station,omitempty"` // Console, RDP-Tcp#0...
	State   string `json:"state"`             // active | locked | disconnected
	LogonAt int64  `json:"logonAt,omitempty"` // unix ms
	// unix ms of the last change of State (logon, lock, unlock, disconnection); first sight of the session when
	// the agent started after it (the date is kept in memory only)
	StateAt int64 `json:"stateAt,omitempty"`
	// keyboard/mouse input within idleThreshold in an active (unlocked) session
	Interactive bool `json:"interactive"`
	// seconds since the last input; nil when unknown. Not part of the change detection (it moves all the time).
	IdleSec *int64 `json:"idleSec,omitempty"`
}

type SessionReport struct {
	CheckedAt int64     `json:"checkedAt"` // unix ms
	Sessions  []Session `json:"sessions"`
}

type InstalledSoftware struct {
	Name      string `json:"name"`
	Version   string `json:"version,omitempty"`
	Publisher string `json:"publisher,omitempty"`
	Source    string `json:"source"` // winget | registry
}

type InstalledSoftwareReport struct {
	CheckedAt int64               `json:"checkedAt"` // unix ms
	Items     []InstalledSoftware `json:"items"`
}

type WingetUpdate struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Current   string `json:"current,omitempty"`
	Available string `json:"available,omitempty"`
	Source    string `json:"source,omitempty"`
}

type WindowsUpdate struct {
	Title       string `json:"title"`
	KBArticleID string `json:"kbArticleId,omitempty"`
	Size        int64  `json:"size,omitempty"`
	Severity    string `json:"severity,omitempty"`
}

type PendingUpdatesReport struct {
	CheckedAt int64           `json:"checkedAt"` // unix ms
	Winget    []WingetUpdate  `json:"winget"`
	Windows   []WindowsUpdate `json:"windows"`
}

// agent -> hub
type Outbound struct {
	Type              string                   `json:"type"` // hello | session_report | software_report | pending_updates_report | rpc_result | job_log | job_done | backup_synced | backup_result | ups_report
	Version           string                   `json:"version,omitempty"`
	Info              *HostInfo                `json:"info,omitempty"`
	Capabilities      []string                 `json:"capabilities,omitempty"`
	BinaryHash        string                   `json:"binaryHash,omitempty"`
	Sessions          *SessionReport           `json:"sessions,omitempty"`
	InstalledSoftware *InstalledSoftwareReport `json:"installedSoftware,omitempty"`
	PendingUpdates    *PendingUpdatesReport    `json:"pendingUpdates,omitempty"`
	Ups               *UpsReport               `json:"ups,omitempty"`
	HealthSystem      *HealthSystem            `json:"healthSystem,omitempty"`
	HealthDisks       *HealthDisks             `json:"healthDisks,omitempty"`
	HealthSmart       *HealthSmart             `json:"healthSmart,omitempty"`
	HealthRaid        *HealthRaid              `json:"healthRaid,omitempty"`
	ReqID             string                   `json:"reqId,omitempty"`
	Result            any                      `json:"result,omitempty"`
	JobID             string                   `json:"jobId,omitempty"`
	Data              string                   `json:"data,omitempty"`
	ExitCode          int                      `json:"exitCode,omitempty"`
	Error             string                   `json:"error,omitempty"`
}

// hub -> agent
type Inbound struct {
	Type   string `json:"type"` // run | rpc | backup_sync | backup_result_ack (anything else is ignored)
	JobID  string `json:"jobId"`
	Action string `json:"action"`
	// apt_upgrade, winget_upgrade: package ids (empty: all updates)
	Packages []string `json:"packages,omitempty"`
	ReqID    string   `json:"reqId,omitempty"`
	Op       string   `json:"op,omitempty"`
	Scopes   []string `json:"scopes,omitempty"`
	Sha256   string   `json:"sha256,omitempty"` // agent_update: expected hash of the new binary
	// lock: the session to lock
	SessionID *uint32 `json:"sessionId,omitempty"`
	// backup_sync: the whole definition of the backups of this host (backup.go)
	Backup *BackupSpec `json:"backup,omitempty"`
	// backup_run: the backup job to run now
	BackupJob    string       `json:"backupJob,omitempty"`
	HealthConfig HealthConfig `json:"healthConfig,omitempty"`
}
