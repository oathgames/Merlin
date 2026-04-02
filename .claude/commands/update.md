---
name: update
description: Check for and install AutoCMO updates from GitHub. Updates generic files and binary while preserving your brand data, config, and memory.
user-invocable: true
---

You are the AutoCMO updater. Follow these steps exactly.

## Step 1: Check for updates

Fetch the remote version manifest:
```
WebFetch https://raw.githubusercontent.com/oathgames/AutoCMO/main/version.json
```

Read the local `version.json` in the project root. Compare versions.

If the remote version is the same or older, report "( ◕ ◡ ◕ ) AutoCMO is up to date (vX.X.X)" and stop.

## Step 2: Back up current files

Create a backup directory: `.autocmo-backup/{local-version}/`

For each file listed in the remote `updatable` array that exists locally, copy it to the backup directory preserving the path structure.

Report: "Backed up {N} files to .autocmo-backup/{version}/"

## Step 3: Update generic files

For each file in the remote `updatable` array:
1. Fetch from `https://raw.githubusercontent.com/oathgames/AutoCMO/main/{path}`
2. Write to the local path, overwriting the existing file

**NEVER touch these user files:**
- `memory.md` — user's learning memory
- `.claude/tools/autocmo-config.json` — user's API keys and config
- `results/` — user's generated content
- Any brand folder in `assets/brands/` EXCEPT `example/` (example is updatable, user brands are not)

## Step 4: Update the binary

Detect the platform:
- Windows: `AutoCMO-windows-amd64.exe`
- macOS ARM64: `AutoCMO-darwin-arm64`
- macOS Intel: `AutoCMO-darwin-amd64`
- Linux: `AutoCMO-linux-amd64`

Download the correct binary from the latest GitHub release:
```bash
curl -L -o .claude/tools/AutoCMO.exe.download "https://github.com/oathgames/AutoCMO/releases/latest/download/{binary-name}"
```

Verify the download is valid (not a 404 HTML page or empty file):
```bash
# Check file size — binary should be at least 1MB
wc -c < .claude/tools/AutoCMO.exe.download
```

If the file is under 1MB or contains "Not Found", delete it and report the error. Do NOT replace the existing binary.

If valid, replace:
```bash
mv .claude/tools/AutoCMO.exe .claude/tools/AutoCMO.exe.backup
mv .claude/tools/AutoCMO.exe.download .claude/tools/AutoCMO.exe
chmod +x .claude/tools/AutoCMO.exe
```

On macOS, also run:
```bash
xattr -d com.apple.quarantine .claude/tools/AutoCMO.exe
codesign --force --sign - .claude/tools/AutoCMO.exe
```

Verify the new binary works:
```bash
.claude/tools/AutoCMO.exe --version
```

If the version check fails, roll back:
```bash
mv .claude/tools/AutoCMO.exe.backup .claude/tools/AutoCMO.exe
```
Report the error and keep the old binary.

If successful, delete the backup: `rm .claude/tools/AutoCMO.exe.backup`

## Step 5: Report

```
( ◕ ◡ ◕ )  AutoCMO updated: v{old} → v{new}

Updated files:
  ✓ CLAUDE.md
  ✓ .claude/commands/cmo.md
  ✓ (etc.)

Preserved (untouched):
  ✓ memory.md
  ✓ assets/brands/{user-brands}/
  ✓ .claude/tools/autocmo-config.json

Binary: ✓ AutoCMO.exe replaced (verified)

Backup: .autocmo-backup/{old-version}/

{release notes from version.json}
```
