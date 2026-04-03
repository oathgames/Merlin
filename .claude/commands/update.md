---
name: update
description: Check for and install R2 updates from GitHub. Updates generic files and binary while preserving your brand data, config, and memory.
user-invocable: true
---

You are the R2 updater. Follow these steps exactly.

## Step 1: Check for updates

Fetch the remote version manifest:
```
WebFetch https://raw.githubusercontent.com/oathgames/R2/main/version.json
```

Read the local `version.json` in the project root. Compare versions.

If the remote version is the same or older, report "( ◕ ◡ ◕ ) R2 is up to date (vX.X.X)" and stop.

## Step 2: Back up current files

Create a backup directory: `.r2-backup/{local-version}/`

For each file listed in the remote `updatable` array that exists locally, copy it to the backup directory preserving the path structure.

Report: "Backed up {N} files to .r2-backup/{version}/"

## Step 3: Update generic files

For each file in the remote `updatable` array:
1. Fetch from `https://raw.githubusercontent.com/oathgames/R2/main/{path}`
2. Write to the local path, overwriting the existing file

**NEVER touch these user files:**
- `memory.md` — user's learning memory
- `.claude/tools/r2-config.json` — user's API keys and config
- `results/` — user's generated content
- Any brand folder in `assets/brands/` EXCEPT `example/` (example is updatable, user brands are not)

## Step 4: Update the binary

Detect the platform:
- Windows: `R2-windows-amd64.exe`
- macOS ARM64: `R2-darwin-arm64`
- macOS Intel: `R2-darwin-amd64`
- Linux: `R2-linux-amd64`

Download the correct binary from the latest GitHub release:
```bash
curl -L -o .claude/tools/R2.exe.download "https://github.com/oathgames/R2/releases/latest/download/{binary-name}"
```

Verify the download is valid (not a 404 HTML page or empty file):
```bash
# Check file size — binary should be at least 1MB
wc -c < .claude/tools/R2.exe.download
```

If the file is under 1MB or contains "Not Found", delete it and report the error. Do NOT replace the existing binary.

If valid, replace:
```bash
mv .claude/tools/R2.exe .claude/tools/R2.exe.backup
mv .claude/tools/R2.exe.download .claude/tools/R2.exe
chmod +x .claude/tools/R2.exe
```

On macOS, also run:
```bash
xattr -d com.apple.quarantine .claude/tools/R2.exe
codesign --force --sign - .claude/tools/R2.exe
```

Verify the new binary works:
```bash
.claude/tools/R2.exe --version
```

If the version check fails, roll back:
```bash
mv .claude/tools/R2.exe.backup .claude/tools/R2.exe
```
Report the error and keep the old binary.

If successful, delete the backup: `rm .claude/tools/R2.exe.backup`

## Step 5: Report

```
( ◕ ◡ ◕ )  R2 updated: v{old} → v{new}

Updated files:
  ✓ CLAUDE.md
  ✓ .claude/commands/cmo.md
  ✓ (etc.)

Preserved (untouched):
  ✓ memory.md
  ✓ assets/brands/{user-brands}/
  ✓ .claude/tools/r2-config.json

Binary: ✓ R2.exe replaced (verified)

Backup: .r2-backup/{old-version}/

{release notes from version.json}
```
