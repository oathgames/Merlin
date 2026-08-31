; REGRESSION GUARD (2026-08-31, installer-name-collision): every process check
; and kill in this file is scoped BY EXECUTABLE PATH, never by process name.
;
; TWO different programs on a Merlin machine are both named Merlin.exe:
;
;   $INSTDIR\Merlin.exe                        the Electron shell (~220 MB)
;   %LOCALAPPDATA%\Merlin\bin\Merlin.exe       the Go engine (~19 MB)
;
; The engine is short-lived and spawned constantly: by the app, by the
; watchdog, and by the Merlin MCP server running inside any Claude Code
; session. electron-builder's stock app-running check is name-based
; (nsProcess::_FindProcess "Merlin.exe"), so it sees an engine invocation,
; reports "Merlin cannot be closed. Please close it manually and click Retry
; to continue," and Retry finds the next one. The install can never proceed,
; and the user is told to close an app that is already closed. Live incident
; 2026-08-31: a user could not install v1.39.1 by any route.
;
; The old name-based `taskkill /IM Merlin.exe /T` had the mirror-image
; problem: installing the app killed unrelated in-flight engine work, which
; is exactly the mid-write kill the 2026-04-23 guard below exists to avoid.
;
; DO NOT reintroduce a bare /IM or a _FindProcess on the name. Match the path.
;
; The target path is handed to PowerShell through an environment variable
; rather than interpolated into the command line. NSIS has no escape syntax
; for a quote inside a same-quoted string, so nesting NSIS quoting inside
; PowerShell quoting inside a WMI filter is unverifiable by reading and
; silently produces a command that matches nothing. One env var removes all
; three layers.

!macro KillAppByPath
  ; Graceful-close window before hard-kill, scoped to $INSTDIR\Merlin.exe.
  ;
  ; REGRESSION GUARD (2026-04-23): an earlier block issued a soft taskkill
  ; immediately followed by `taskkill /F`, with no gap for Merlin.exe to flush
  ; in-flight writes. The Go binary runs with two rate-limit-critical files
  ; open at any given moment (`.merlin-ratelimit*`) and a vault atomic-rename
  ; temp (`.merlin-vault*.tmp`); see CLAUDE.md Security Rule 4. A hard kill
  ; during the wrong millisecond truncates the state file, which trips the
  ; HMAC check on next launch and drops the user into 24h safe mode for no
  ; reason. Give the process up to 5 seconds to exit cleanly, then escalate.
  ;
  ; The whole graceful/poll/escalate cycle lives inside ONE PowerShell call
  ; rather than an NSIS loop. This macro is expanded twice (customInit and
  ; customCheckAppRunning) and NSIS labels are function-scoped, so an NSIS
  ; loop here fails to compile with "label already declared" the moment both
  ; expansions land in .onInit. No labels, no collision.
  System::Call 'kernel32::SetEnvironmentVariable(t "MERLIN_KILL_TARGET", t "$INSTDIR\${APP_EXECUTABLE_FILENAME}")i.r0'
  nsExec::Exec 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$t=$$env:MERLIN_KILL_TARGET; $$f={ @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq $$t }) }; & $$f | ForEach-Object { try { $$_.CloseMainWindow() } catch { } }; for ($$i=0; $$i -lt 10 -and (& $$f).Count -gt 0; $$i++) { Start-Sleep -Milliseconds 500; & $$f | ForEach-Object { try { $$_.CloseMainWindow() } catch { } } }; if ((& $$f).Count -gt 0) { & $$f | Stop-Process -Force -ErrorAction SilentlyContinue }"'
  Pop $0
!macroend

!macro customInit
  !insertmacro KillAppByPath
!macroend

; Replace electron-builder's stock name-based running check entirely. Ours
; closes the shell by path and then returns, so the "cannot be closed" dialog
; can never fire on an engine process that was never the app.
!macro customCheckAppRunning
  !insertmacro KillAppByPath
!macroend

!macro customInstall
  ; Skip auto-launch for silent installs (CI/managed deployment).
  IfSilent done

  ; Primary path: launch detached via Task Scheduler to avoid installer file locks.
  nsExec::Exec 'schtasks /Create /TN MerlinLaunch /TR "\"$INSTDIR\${APP_EXECUTABLE_FILENAME}\"" /SC ONCE /ST 00:00 /F'
  Pop $0
  StrCmp $0 "0" 0 launch_fallback

  nsExec::Exec 'schtasks /Run /TN MerlinLaunch'
  Pop $0
  StrCmp $0 "0" 0 launch_fallback

  ; Give Task Scheduler a moment to hand off before deleting the task definition.
  Sleep 1000
  nsExec::Exec 'schtasks /Delete /TN MerlinLaunch /F'
  Pop $0
  Goto done

launch_fallback:
  ; Fallback for systems where Task Scheduler is disabled by policy.
  nsExec::Exec 'schtasks /Delete /TN MerlinLaunch /F'
  Pop $0
  ${StdUtils.ExecShellAsUser} $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""

done:
!macroend
