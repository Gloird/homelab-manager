//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func runWingetOutputAsActiveUser(ctx context.Context, args ...string) ([]byte, error) {
	sessions, err := collectSessions()
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	var sessionID uint32
	found := false
	for _, s := range sessions.Sessions {
		if s.State == "active" {
			sessionID = s.ID
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("no active interactive session")
	}
	var token windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &token); err != nil {
		return nil, fmt.Errorf("user token session %d: %w", sessionID, err)
	}
	defer token.Close()

	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmdLine := windows.EscapeArg(exe) + " winget-proxy"
	for _, arg := range args {
		cmdLine += " " + windows.EscapeArg(arg)
	}
	cmd, _ := windows.UTF16PtrFromString(cmdLine)
	desktop, _ := windows.UTF16PtrFromString(`winsta0\default`)

	var r, w windows.Handle
	if err := windows.CreatePipe(&r, &w, nil, 0); err != nil {
		return nil, err
	}
	defer windows.CloseHandle(w)
	if err := windows.SetHandleInformation(w, windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT); err != nil {
		_ = windows.CloseHandle(r)
		return nil, err
	}

	si := windows.StartupInfo{
		Desktop:   desktop,
		Flags:     windows.STARTF_USESTDHANDLES,
		StdOutput: w,
		StdErr:    w,
	}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	syscall.ForkLock.Lock()
	err = windows.CreateProcessAsUser(token, nil, cmd, nil, nil, true, windows.CREATE_NO_WINDOW, nil, nil, &si, &pi)
	syscall.ForkLock.Unlock()
	_ = windows.CloseHandle(w)
	if err != nil {
		_ = windows.CloseHandle(r)
		return nil, fmt.Errorf("start winget proxy: %w", err)
	}
	defer windows.CloseHandle(pi.Thread)
	defer windows.CloseHandle(pi.Process)

	outFile := os.NewFile(uintptr(r), "winget-proxy-output")
	defer outFile.Close()
	outCh := make(chan []byte, 1)
	errCh := make(chan error, 1)
	go func() {
		b, e := io.ReadAll(outFile)
		if e != nil {
			errCh <- e
			return
		}
		outCh <- b
	}()

	done := make(chan struct{})
	waitErr := make(chan error, 1)
	go func() {
		_, e := windows.WaitForSingleObject(pi.Process, windows.INFINITE)
		if e != nil {
			waitErr <- e
		}
		close(done)
	}()
	select {
	case <-ctx.Done():
		_ = windows.TerminateProcess(pi.Process, 1)
		<-done
		return nil, ctx.Err()
	case <-done:
	}

	select {
	case e := <-waitErr:
		return nil, e
	default:
	}
	var code uint32
	if err := windows.GetExitCodeProcess(pi.Process, &code); err != nil {
		return nil, err
	}
	var out []byte
	select {
	case out = <-outCh:
	case e := <-errCh:
		return nil, e
	}
	if code != 0 {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = fmt.Sprintf("exit %d", code)
		}
		return out, errors.New(msg)
	}
	return out, nil
}
