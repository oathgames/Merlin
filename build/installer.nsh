!macro customInit
  ; Graceful-close window before hard-kill.
  ;
  ; REGRESSION GUARD (2026-04-23): the previous block issued a soft taskkill
  ; immediately followed by `taskkill /F`, with no gap for Merlin.exe to flush
  ; in-flight writes. The Go binary runs with two rate-limit-critical files
  ; open at any given moment (`.merlin-ratelimit*`) and a vault atomic-rename
  ; temp (`.merlin-vault*.tmp`); see CLAUDE.md Security Rule 4. A hard kill
  ; during the wrong millisecond truncates the state file, which trips the
  ; HMAC check on next launch and drops the user into 24h safe mode for no
  ; reason. Give the process up to 5 seconds to exit cleanly, then escalate.
  ;
  ; Polling design: up to 10 iterations of (500ms sleep + liveness probe).
  ; Liveness probe is `taskkill /IM Merlin.exe` (no /F, no /T) run in a
  ; best-effort loop; its exit code is 128 when no matching process exists,
  ; 0 when it successfully signalled one. We re-send the soft signal each
  ; iteration so a process that ignored the first WM_CLOSE still gets
  ; nudged (cheap, safe, no /F yet). Exit code is locale-independent,
  ; unlike tasklist's stdout text. If we fall off the loop with the process
  ; still alive, escalate to /F.
  nsExec::Exec 'taskkill /IM Merlin.exe /T'
  Pop $0

  StrCpy $1 0 ; loop counter
  graceful_wait_loop:
    IntCmp $1 10 graceful_give_up
    Sleep 500
    nsExec::Exec 'taskkill /IM Merlin.exe'
    Pop $2
    StrCmp $2 "128" graceful_done
    IntOp $1 $1 + 1
    Goto graceful_wait_loop

  graceful_give_up:
    ; Still running after 5s — assume hung, escalate to force-kill.
    nsExec::Exec 'taskkill /F /IM Merlin.exe /T'
    Pop $0

  graceful_done:
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
