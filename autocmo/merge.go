package main

import (
	"archive/zip"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// mergeVideoAudio combines a video file and audio file into a single MP4.
// If the audio is longer than the video, the video loops. If shorter, it trims.
// Uses ffmpeg — auto-downloads a static binary if not found.
func mergeVideoAudio(videoPath, audioPath, outputPath string) error {
	ffmpeg, err := findOrDownloadFFmpeg()
	if err != nil {
		return fmt.Errorf("ffmpeg not available: %w", err)
	}

	// Merge: use audio duration as master, loop video if needed
	// -stream_loop -1 = loop video infinitely, -shortest = stop when audio ends
	args := []string{
		"-y",                    // Overwrite output
		"-stream_loop", "-1",   // Loop video
		"-i", videoPath,        // Video input
		"-i", audioPath,        // Audio input
		"-map", "0:v:0",        // Take video from first input
		"-map", "1:a:0",        // Take audio from second input
		"-c:v", "copy",         // Copy video codec (no re-encode)
		"-c:a", "aac",          // Encode audio as AAC for MP4 compat
		"-b:a", "192k",         // Audio bitrate
		"-shortest",            // Stop when the shorter stream ends
		"-movflags", "+faststart", // Web-optimized MP4
		outputPath,
	}

	fmt.Printf("  Merging video + audio...\n")
	cmd := exec.Command(ffmpeg, args...)
	cmd.Stderr = io.Discard // Suppress ffmpeg's verbose stderr
	output, err := cmd.Output()
	if err != nil {
		// On failure, try without -stream_loop (older ffmpeg or single-pass)
		args2 := []string{
			"-y",
			"-i", videoPath,
			"-i", audioPath,
			"-map", "0:v:0",
			"-map", "1:a:0",
			"-c:v", "copy",
			"-c:a", "aac",
			"-b:a", "192k",
			"-shortest",
			"-movflags", "+faststart",
			outputPath,
		}
		cmd2 := exec.Command(ffmpeg, args2...)
		output, err = cmd2.CombinedOutput()
		if err != nil {
			return fmt.Errorf("ffmpeg merge failed: %w\n%s", err, string(output))
		}
	}

	info, err := os.Stat(outputPath)
	if err != nil {
		return fmt.Errorf("merge output not found: %w", err)
	}

	_ = output
	fmt.Printf("  Merged: %s (%.0f KB)\n", filepath.Base(outputPath), float64(info.Size())/1024)
	return nil
}

// findOrDownloadFFmpeg locates ffmpeg on PATH or next to the exe.
// ffmpeg should be bundled with the distribution — no auto-download.
func findOrDownloadFFmpeg() (string, error) {
	// Check PATH first
	if path, err := exec.LookPath("ffmpeg"); err == nil {
		return path, nil
	}

	// Check our tools directory (bundled with the app)
	toolsDir := ""
	if exe, err := os.Executable(); err == nil {
		toolsDir = filepath.Dir(exe)
	} else {
		toolsDir = "."
	}

	localName := "ffmpeg"
	if runtime.GOOS == "windows" {
		localName = "ffmpeg.exe"
	}
	localPath := filepath.Join(toolsDir, localName)

	if _, err := os.Stat(localPath); err == nil {
		return localPath, nil
	}

	// Not found — offer to download
	fmt.Println("  ffmpeg not found next to AutoCMO or on PATH")
	fmt.Println("  Downloading static binary (one-time)...")
	if err := downloadFFmpeg(localPath); err != nil {
		return "", fmt.Errorf("ffmpeg not available: %w\n  Place ffmpeg next to AutoCMO or install it on your PATH", err)
	}

	return localPath, nil
}

// downloadFFmpeg fetches a static ffmpeg binary for the current platform.
func downloadFFmpeg(destPath string) error {
	var url string

	switch runtime.GOOS {
	case "windows":
		// BtbN static build — essentials (smaller, ~30MB zip)
		url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
	case "darwin":
		// evermeet.cx static builds for macOS
		url = "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip"
	case "linux":
		url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
	default:
		return fmt.Errorf("unsupported OS: %s — install ffmpeg manually", runtime.GOOS)
	}

	fmt.Printf("  Downloading from: %s\n", url)

	client := &http.Client{
		Timeout: 300 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}

	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d downloading ffmpeg", resp.StatusCode)
	}

	// Save to temp file first
	tmpFile, err := os.CreateTemp(filepath.Dir(destPath), "ffmpeg-download-*")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)

	n, err := io.Copy(tmpFile, resp.Body)
	tmpFile.Close()
	if err != nil {
		return fmt.Errorf("download incomplete: %w", err)
	}
	fmt.Printf("  Downloaded: %.0f MB\n", float64(n)/(1024*1024))

	// Extract ffmpeg binary from archive
	if strings.HasSuffix(url, ".zip") || runtime.GOOS == "darwin" {
		return extractFFmpegFromZip(tmpPath, destPath)
	}

	// For tar.xz on Linux — fall back to system tar
	cmd := exec.Command("tar", "xf", tmpPath, "--wildcards", "*/ffmpeg", "-O")
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("cannot extract ffmpeg from archive: %w", err)
	}
	return os.WriteFile(destPath, out, 0755)
}

// extractFFmpegFromZip finds ffmpeg and ffprobe binaries inside a zip archive.
func extractFFmpegFromZip(zipPath, destPath string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("cannot open zip: %w", err)
	}
	defer r.Close()

	destDir := filepath.Dir(destPath)
	targets := map[string]bool{"ffmpeg": false, "ffprobe": false}
	if runtime.GOOS == "windows" {
		targets = map[string]bool{"ffmpeg.exe": false, "ffprobe.exe": false}
	}

	for _, f := range r.File {
		name := filepath.Base(f.Name)
		if _, want := targets[name]; !want || f.FileInfo().IsDir() {
			continue
		}

		rc, err := f.Open()
		if err != nil {
			return err
		}

		outPath := filepath.Join(destDir, name)
		out, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
		if err != nil {
			rc.Close()
			return err
		}

		written, err := io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return err
		}

		targets[name] = true
		fmt.Printf("  Extracted: %s (%.0f MB)\n", name, float64(written)/(1024*1024))
	}

	if !targets["ffmpeg"] && !targets["ffmpeg.exe"] {
		return fmt.Errorf("ffmpeg binary not found in zip archive")
	}

	return nil
}

// pickMusicTrack selects a random music file from a directory.
// Supports .mp3, .wav, .ogg, .flac, .m4a.
// ensureMusicPack checks if any music tracks exist in the music directory.
// If empty, downloads the CC0 music pack from the latest GitHub Release.
func ensureMusicPack(musicDir string) {
	if musicDir == "" {
		return
	}
	// Check if any tracks already exist
	entries, err := os.ReadDir(musicDir)
	if err == nil {
		for _, e := range entries {
			ext := strings.ToLower(filepath.Ext(e.Name()))
			switch ext {
			case ".mp3", ".wav", ".ogg", ".flac", ".m4a":
				return // Already have music
			}
		}
	}

	// No tracks — download the CC0 music pack
	fmt.Println("  Downloading CC0 music pack (one-time, ~44MB)...")
	packURL := updateURL + "/autocmo-music-pack.zip"

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(packURL)
	if err != nil {
		fmt.Printf("  [WARN] Cannot download music pack: %v\n", err)
		fmt.Println("  Drop .mp3 files into assets/music/ manually.")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		fmt.Printf("  [WARN] Music pack not available (HTTP %d)\n", resp.StatusCode)
		return
	}

	// Save to temp file
	os.MkdirAll(musicDir, 0755)
	tmpPath := filepath.Join(musicDir, "music-pack.zip")
	f, err := os.Create(tmpPath)
	if err != nil {
		fmt.Printf("  [WARN] Cannot create temp file: %v\n", err)
		return
	}

	n, err := io.Copy(f, resp.Body)
	f.Close()
	if err != nil {
		os.Remove(tmpPath)
		fmt.Printf("  [WARN] Download incomplete: %v\n", err)
		return
	}

	// Extract zip
	r, err := zip.OpenReader(tmpPath)
	if err != nil {
		os.Remove(tmpPath)
		fmt.Printf("  [WARN] Cannot open music pack: %v\n", err)
		return
	}

	extracted := 0
	for _, zf := range r.File {
		if zf.FileInfo().IsDir() {
			continue
		}
		destPath := filepath.Join(musicDir, filepath.Base(zf.Name))
		src, err := zf.Open()
		if err != nil {
			continue
		}
		dst, err := os.Create(destPath)
		if err != nil {
			src.Close()
			continue
		}
		io.Copy(dst, src)
		dst.Close()
		src.Close()
		extracted++
	}
	r.Close()
	os.Remove(tmpPath)

	fmt.Printf("  Downloaded %d CC0 music tracks (%.1f MB)\n", extracted, float64(n)/1024/1024)
}

func pickMusicTrack(musicDir string) string {
	if musicDir == "" {
		return ""
	}
	entries, err := os.ReadDir(musicDir)
	if err != nil {
		return ""
	}
	var tracks []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		switch ext {
		case ".mp3", ".wav", ".ogg", ".flac", ".m4a":
			tracks = append(tracks, filepath.Join(musicDir, e.Name()))
		}
	}
	if len(tracks) == 0 {
		return ""
	}
	return tracks[rand.Intn(len(tracks))]
}

// mixMusicBed takes a video (already merged with voiceover) and mixes a background
// music track at -18dB underneath the existing audio. Output is a new file.
func mixMusicBed(videoPath, musicPath, outputPath string) error {
	ffmpeg, err := findOrDownloadFFmpeg()
	if err != nil {
		return fmt.Errorf("ffmpeg not available: %w", err)
	}

	// Get video duration to trim music
	probe := ffprobeJSON(videoPath)
	if probe == nil {
		return fmt.Errorf("cannot probe video for music mixing")
	}
	dur := probe.Duration()
	if dur <= 0 {
		return fmt.Errorf("video has no duration")
	}

	// Mix: keep original audio at full volume, add music at -18dB, trim music to video length
	// amix with volume weights: voice=1.0, music=0.125 (~-18dB)
	filterComplex := fmt.Sprintf(
		"[1:a]volume=0.125,afade=t=in:st=0:d=2,afade=t=out:st=%.1f:d=2[music];"+
			"[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[out]",
		dur-2,
	)

	args := []string{
		"-y",
		"-i", videoPath,
		"-i", musicPath,
		"-filter_complex", filterComplex,
		"-map", "0:v:0",
		"-map", "[out]",
		"-c:v", "copy",
		"-c:a", "aac",
		"-b:a", "192k",
		"-shortest",
		"-movflags", "+faststart",
		outputPath,
	}

	fmt.Printf("  Mixing music bed (%s) at -18dB...\n", filepath.Base(musicPath))
	cmd := exec.Command(ffmpeg, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("music mix failed: %w\n%s", err, string(out))
	}

	info, _ := os.Stat(outputPath)
	if info != nil {
		fmt.Printf("  Mixed: %s (%.0f KB)\n", filepath.Base(outputPath), float64(info.Size())/1024)
	}
	return nil
}
