package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ── SEO Keyword Research & Rank Tracking ───────────────────

// SEORankingFile is the top-level structure for seo-rankings.json.
type SEORankingFile struct {
	Domain   string           `json:"domain"`
	Keywords []SEOTrackedWord `json:"keywords"`
}

// SEOTrackedWord is a keyword with its position history.
type SEOTrackedWord struct {
	Keyword   string            `json:"keyword"`
	Positions []SEOPositionSnap `json:"positions"`
}

// SEOPositionSnap is a single rank observation.
type SEOPositionSnap struct {
	Date     string `json:"date"`
	Position int    `json:"position"`
}

// SEOKeywordEntry is a researched keyword with estimated metrics.
type SEOKeywordEntry struct {
	Keyword    string `json:"keyword"`
	Volume     string `json:"volume"`     // "low", "medium", "high"
	Difficulty string `json:"difficulty"` // "easy", "medium", "hard"
	Source     string `json:"source"`     // "autocomplete", "alphabet-expansion"
}

// ── Google Autocomplete ────────────────────────────────────

// seoGetKeywordSuggestions fetches Google autocomplete suggestions for a query.
// No API key needed — uses the public suggest endpoint.
func seoGetKeywordSuggestions(query string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 10
	}

	u := fmt.Sprintf(
		"http://suggestqueries.google.com/complete/search?client=firefox&q=%s",
		url.QueryEscape(query),
	)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(u)
	if err != nil {
		return nil, fmt.Errorf("autocomplete request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("autocomplete HTTP %d: %s", resp.StatusCode, string(body))
	}

	// Response format: ["query", ["suggestion1", "suggestion2", ...]]
	var raw []json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("cannot parse autocomplete response: %w", err)
	}
	if len(raw) < 2 {
		return nil, nil
	}

	var suggestions []string
	if err := json.Unmarshal(raw[1], &suggestions); err != nil {
		return nil, fmt.Errorf("cannot parse suggestions: %w", err)
	}

	if len(suggestions) > limit {
		suggestions = suggestions[:limit]
	}
	return suggestions, nil
}

// ── Brand Directory Helper ─────────────────────────────────

// seoBrandDir resolves the brand assets directory.
// Returns the path to assets/brands/<brand>/, creating it if needed.
func seoBrandDir(cfg *Config) string {
	brandsDir := filepath.Join(cfg.OutputDir, "..", "assets", "brands")

	// Try to match by productName
	if cfg.ProductName != "" {
		entries, _ := os.ReadDir(brandsDir)
		for _, e := range entries {
			if e.IsDir() && strings.EqualFold(e.Name(), cfg.ProductName) {
				return filepath.Join(brandsDir, e.Name())
			}
		}
	}

	// Use first brand directory found
	entries, _ := os.ReadDir(brandsDir)
	for _, e := range entries {
		if e.IsDir() {
			return filepath.Join(brandsDir, e.Name())
		}
	}

	// Fallback: create a default brand dir
	dir := filepath.Join(brandsDir, "default")
	os.MkdirAll(dir, 0755)
	return dir
}

// ── Keyword Research ───────────────────────────────────────

// seoResearchKeywords is the CLI entry point for keyword research.
// Takes comma-separated seed keywords, expands via autocomplete + alphabet,
// optionally estimates volume/difficulty via Gemini.
func seoResearchKeywords(cfg *Config, seedCSV string) {
	fmt.Println("============================================================")
	fmt.Println("  SEO Keyword Research")
	fmt.Println("============================================================")

	seeds := strings.Split(seedCSV, ",")
	for i := range seeds {
		seeds[i] = strings.TrimSpace(seeds[i])
	}

	// Deduplicate all keywords
	seen := map[string]bool{}
	type kw struct {
		keyword string
		source  string
	}
	var allKW []kw

	addUnique := func(keyword, source string) {
		lower := strings.ToLower(strings.TrimSpace(keyword))
		if lower == "" || seen[lower] {
			return
		}
		seen[lower] = true
		allKW = append(allKW, kw{keyword: lower, source: source})
	}

	for _, seed := range seeds {
		if seed == "" {
			continue
		}
		fmt.Printf("  Expanding: %s\n", seed)

		// Direct autocomplete
		suggestions, err := seoGetKeywordSuggestions(seed, 10)
		if err != nil {
			fmt.Printf("  [WARN] Autocomplete failed for %q: %v\n", seed, err)
		}
		for _, s := range suggestions {
			addUnique(s, "autocomplete")
		}

		// Alphabet expansion: "seed a", "seed b", etc.
		for c := 'a'; c <= 'z'; c++ {
			expanded := fmt.Sprintf("%s %c", seed, c)
			subs, err := seoGetKeywordSuggestions(expanded, 5)
			if err != nil {
				continue
			}
			for _, s := range subs {
				addUnique(s, "alphabet-expansion")
			}
		}
	}

	fmt.Printf("\n  Found %d unique keywords\n", len(allKW))

	// Build keyword entries
	entries := make([]SEOKeywordEntry, len(allKW))
	for i, k := range allKW {
		entries[i] = SEOKeywordEntry{
			Keyword:    k.keyword,
			Volume:     "-",
			Difficulty: "-",
			Source:     k.source,
		}
	}

	// If Gemini is available, estimate volume/difficulty for top 20
	if cfg.GoogleAPIKey != "" && len(entries) > 0 {
		top := entries
		if len(top) > 20 {
			top = top[:20]
		}
		fmt.Println("  Estimating volume & difficulty via Gemini...")
		estimates := seoGeminiEstimate(cfg, top)
		for i := range estimates {
			if i < len(entries) {
				entries[i].Volume = estimates[i].Volume
				entries[i].Difficulty = estimates[i].Difficulty
			}
		}
	}

	// Print table
	fmt.Printf("\n  %-50s %-10s %-10s %s\n", "KEYWORD", "VOLUME", "DIFFICULTY", "SOURCE")
	fmt.Println("  ──────────────────────────────────────────────────────────────────────────────────")
	for _, e := range entries {
		kw := e.Keyword
		if len(kw) > 48 {
			kw = kw[:48] + ".."
		}
		fmt.Printf("  %-50s %-10s %-10s %s\n", kw, e.Volume, e.Difficulty, e.Source)
	}

	// Save to brand dir
	brandDir := seoBrandDir(cfg)
	outPath := filepath.Join(brandDir, "seo-keywords.json")
	jsonData, _ := json.MarshalIndent(entries, "", "  ")
	if err := os.WriteFile(outPath, jsonData, 0644); err != nil {
		fmt.Printf("  [WARN] Cannot write %s: %v\n", outPath, err)
	} else {
		fmt.Printf("\n  Saved: %s\n", outPath)
	}
}

// seoGeminiEstimate uses Gemini to estimate search volume and difficulty for keywords.
func seoGeminiEstimate(cfg *Config, keywords []SEOKeywordEntry) []SEOKeywordEntry {
	// Build keyword list for the prompt
	kwList := make([]string, len(keywords))
	for i, k := range keywords {
		kwList[i] = k.Keyword
	}

	prompt := fmt.Sprintf(`You are an SEO expert. For each keyword below, estimate:
1. Search volume: "low" (<1K monthly), "medium" (1K-10K), or "high" (>10K)
2. Ranking difficulty: "easy" (low competition), "medium", or "hard" (very competitive)

Keywords:
%s

Respond ONLY with a JSON array of objects, each with "keyword", "volume", and "difficulty" fields.
No explanation, no markdown fencing. Just the raw JSON array.`, strings.Join(kwList, "\n"))

	apiURL := fmt.Sprintf(
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=%s",
		cfg.GoogleAPIKey,
	)

	payload := map[string]interface{}{
		"contents": []map[string]interface{}{
			{"parts": []map[string]interface{}{{"text": prompt}}},
		},
		"generationConfig": map[string]interface{}{
			"responseModalities": []string{"TEXT"},
			"temperature":        0.3,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		fmt.Printf("  [WARN] Gemini marshal error: %v\n", err)
		return keywords
	}

	req, err := http.NewRequest("POST", apiURL, bytes.NewReader(body))
	if err != nil {
		fmt.Printf("  [WARN] Gemini request error: %v\n", err)
		return keywords
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("  [WARN] Gemini request failed: %v\n", err)
		return keywords
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		fmt.Printf("  [WARN] Gemini HTTP %d: %s\n", resp.StatusCode, string(respBody))
		return keywords
	}

	// Parse Gemini response
	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text,omitempty"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}

	if err := json.Unmarshal(respBody, &result); err != nil {
		fmt.Printf("  [WARN] Cannot parse Gemini response: %v\n", err)
		return keywords
	}

	for _, c := range result.Candidates {
		for _, p := range c.Content.Parts {
			if p.Text == "" {
				continue
			}
			// Strip markdown fencing if present
			text := strings.TrimSpace(p.Text)
			text = strings.TrimPrefix(text, "```json")
			text = strings.TrimPrefix(text, "```")
			text = strings.TrimSuffix(text, "```")
			text = strings.TrimSpace(text)

			var estimates []SEOKeywordEntry
			if err := json.Unmarshal([]byte(text), &estimates); err != nil {
				fmt.Printf("  [WARN] Cannot parse Gemini estimates: %v\n", err)
				return keywords
			}
			// Merge estimates back
			estMap := map[string]SEOKeywordEntry{}
			for _, e := range estimates {
				estMap[strings.ToLower(e.Keyword)] = e
			}
			for i := range keywords {
				if est, ok := estMap[strings.ToLower(keywords[i].Keyword)]; ok {
					keywords[i].Volume = est.Volume
					keywords[i].Difficulty = est.Difficulty
				}
			}
			return keywords
		}
	}

	return keywords
}

// ── Rank Tracking ──────────────────────────────────────────

// seoLoadRankings loads the seo-rankings.json file for the current brand.
func seoLoadRankings(cfg *Config) (*SEORankingFile, string) {
	brandDir := seoBrandDir(cfg)
	path := filepath.Join(brandDir, "seo-rankings.json")

	data, err := os.ReadFile(path)
	if err != nil {
		// Return empty rankings with domain from product URL
		domain := ""
		if cfg.ProductURL != "" {
			if u, err := url.Parse(cfg.ProductURL); err == nil {
				domain = u.Host
			}
		}
		return &SEORankingFile{Domain: domain}, path
	}

	var rankings SEORankingFile
	if err := json.Unmarshal(data, &rankings); err != nil {
		return &SEORankingFile{}, path
	}
	return &rankings, path
}

// seoSaveRankings writes the rankings file.
func seoSaveRankings(rankings *SEORankingFile, path string) error {
	os.MkdirAll(filepath.Dir(path), 0755)
	data, err := json.MarshalIndent(rankings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// seoTrackRankings initializes tracking for a list of keywords.
func seoTrackRankings(cfg *Config, keywordsCSV string) {
	fmt.Println("============================================================")
	fmt.Println("  SEO Rank Tracking — Initialize Keywords")
	fmt.Println("============================================================")

	rankings, path := seoLoadRankings(cfg)

	keywords := strings.Split(keywordsCSV, ",")
	added := 0
	for _, kw := range keywords {
		kw = strings.TrimSpace(kw)
		if kw == "" {
			continue
		}

		// Check if already tracked
		found := false
		for _, tk := range rankings.Keywords {
			if strings.EqualFold(tk.Keyword, kw) {
				found = true
				break
			}
		}
		if found {
			fmt.Printf("  Already tracked: %s\n", kw)
			continue
		}

		rankings.Keywords = append(rankings.Keywords, SEOTrackedWord{
			Keyword:   kw,
			Positions: []SEOPositionSnap{},
		})
		added++
		fmt.Printf("  Added: %s\n", kw)
	}

	if err := seoSaveRankings(rankings, path); err != nil {
		fmt.Printf("  [WARN] Cannot save rankings: %v\n", err)
	} else {
		fmt.Printf("\n  %d keywords added. File: %s\n", added, path)
	}
}

// seoUpdateRanking appends a new position entry for a tracked keyword.
func seoUpdateRanking(cfg *Config, keyword string, position int) {
	fmt.Println("============================================================")
	fmt.Println("  SEO Rank Tracking — Update Position")
	fmt.Println("============================================================")

	rankings, path := seoLoadRankings(cfg)
	today := time.Now().Format("2006-01-02")

	found := false
	for i, tk := range rankings.Keywords {
		if strings.EqualFold(tk.Keyword, keyword) {
			rankings.Keywords[i].Positions = append(rankings.Keywords[i].Positions, SEOPositionSnap{
				Date:     today,
				Position: position,
			})
			found = true
			fmt.Printf("  Updated: %q → position %d (%s)\n", keyword, position, today)
			break
		}
	}

	if !found {
		// Create new keyword entry
		rankings.Keywords = append(rankings.Keywords, SEOTrackedWord{
			Keyword: keyword,
			Positions: []SEOPositionSnap{
				{Date: today, Position: position},
			},
		})
		fmt.Printf("  Created: %q → position %d (%s)\n", keyword, position, today)
	}

	if err := seoSaveRankings(rankings, path); err != nil {
		fmt.Printf("  [WARN] Cannot save rankings: %v\n", err)
	} else {
		fmt.Printf("  Saved: %s\n", path)
	}
}

// ── Rank Report ────────────────────────────────────────────

// seoRankReport prints current rankings with trend indicators.
func seoRankReport(cfg *Config) {
	fmt.Println("============================================================")
	fmt.Println("  SEO Rank Report")
	fmt.Println("============================================================")

	rankings, _ := seoLoadRankings(cfg)

	if rankings.Domain != "" {
		fmt.Printf("  Domain: %s\n", rankings.Domain)
	}

	if len(rankings.Keywords) == 0 {
		fmt.Println("\n  No keywords tracked yet.")
		fmt.Println("  Use seo-track to add keywords, then seo-update-rank to record positions.")
		return
	}

	fmt.Printf("\n  %-40s %8s %10s %10s %s\n", "KEYWORD", "CURRENT", "7-DAY", "30-DAY", "TREND")
	fmt.Println("  ────────────────────────────────────────────────────────────────────────────────")

	now := time.Now()
	sevenDaysAgo := now.AddDate(0, 0, -7).Format("2006-01-02")
	thirtyDaysAgo := now.AddDate(0, 0, -30).Format("2006-01-02")

	for _, tk := range rankings.Keywords {
		kw := tk.Keyword
		if len(kw) > 38 {
			kw = kw[:38] + ".."
		}

		current := "-"
		var currentPos int
		change7 := "-"
		change30 := "-"
		trend := ""

		if len(tk.Positions) > 0 {
			// Latest position
			latest := tk.Positions[len(tk.Positions)-1]
			currentPos = latest.Position
			current = fmt.Sprintf("%d", currentPos)

			// Find position closest to 7 days ago
			if pos, ok := seoFindNearestPosition(tk.Positions, sevenDaysAgo); ok {
				diff := pos - currentPos // positive = improved (lower rank number is better)
				if diff > 0 {
					change7 = fmt.Sprintf("+%d", diff)
					trend = "UP"
				} else if diff < 0 {
					change7 = fmt.Sprintf("%d", diff)
					trend = "DOWN"
				} else {
					change7 = "0"
					trend = "-"
				}
			}

			// Find position closest to 30 days ago
			if pos, ok := seoFindNearestPosition(tk.Positions, thirtyDaysAgo); ok {
				diff := pos - currentPos
				if diff > 0 {
					change30 = fmt.Sprintf("+%d", diff)
				} else if diff < 0 {
					change30 = fmt.Sprintf("%d", diff)
				} else {
					change30 = "0"
				}
			}
		}

		fmt.Printf("  %-40s %8s %10s %10s %s\n", kw, current, change7, change30, trend)
	}
}

// seoFindNearestPosition finds the position entry nearest to the target date.
func seoFindNearestPosition(positions []SEOPositionSnap, targetDate string) (int, bool) {
	target, err := time.Parse("2006-01-02", targetDate)
	if err != nil {
		return 0, false
	}

	bestPos := 0
	bestDiff := time.Duration(1<<63 - 1) // max duration
	found := false

	for _, p := range positions {
		t, err := time.Parse("2006-01-02", p.Date)
		if err != nil {
			continue
		}
		diff := target.Sub(t)
		if diff < 0 {
			diff = -diff
		}
		// Only consider entries within 7 days of target
		if diff <= 7*24*time.Hour && diff < bestDiff {
			bestDiff = diff
			bestPos = p.Position
			found = true
		}
	}
	return bestPos, found
}

// ── Content Gaps ───────────────────────────────────────────

// seoContentGaps identifies researched keywords with no matching blog content.
func seoContentGaps(cfg *Config) {
	fmt.Println("============================================================")
	fmt.Println("  SEO Content Gap Analysis")
	fmt.Println("============================================================")

	// Load researched keywords
	brandDir := seoBrandDir(cfg)
	kwPath := filepath.Join(brandDir, "seo-keywords.json")
	kwData, err := os.ReadFile(kwPath)
	if err != nil {
		fmt.Printf("\n  No seo-keywords.json found at %s\n", kwPath)
		fmt.Println("  Run seo-keywords first to research keywords.")
		return
	}

	var keywords []SEOKeywordEntry
	if err := json.Unmarshal(kwData, &keywords); err != nil {
		fmt.Printf("  [WARN] Cannot parse %s: %v\n", kwPath, err)
		return
	}

	if len(keywords) == 0 {
		fmt.Println("\n  No keywords found. Run seo-keywords first.")
		return
	}

	// Gather existing content titles
	existingContent := seoGatherExistingContent(cfg)
	fmt.Printf("  Found %d existing content pieces\n", len(existingContent))

	// Find gaps: keywords not covered by any content
	var gaps []SEOKeywordEntry
	for _, kw := range keywords {
		if !seoKeywordCovered(kw.Keyword, existingContent) {
			gaps = append(gaps, kw)
		}
	}

	if len(gaps) == 0 {
		fmt.Println("\n  All researched keywords have matching content. Nice!")
		return
	}

	fmt.Printf("\n  %d keywords with NO blog content:\n\n", len(gaps))
	fmt.Printf("  %-50s %-10s %-10s\n", "KEYWORD", "VOLUME", "DIFFICULTY")
	fmt.Println("  ──────────────────────────────────────────────────────────────────────")
	for _, g := range gaps {
		kw := g.Keyword
		if len(kw) > 48 {
			kw = kw[:48] + ".."
		}
		fmt.Printf("  %-50s %-10s %-10s\n", kw, g.Volume, g.Difficulty)
	}

	// Suggest best next topic: highest volume, easiest difficulty
	best := seoBestGap(gaps)
	if best != nil {
		fmt.Printf("\n  SUGGESTED NEXT BLOG TOPIC:\n")
		fmt.Printf("  → %s (volume: %s, difficulty: %s)\n", best.Keyword, best.Volume, best.Difficulty)
	}
}

// seoGatherExistingContent collects titles of existing content.
// Scans results/ directory for blog output files and tries Shopify API if available.
func seoGatherExistingContent(cfg *Config) []string {
	var titles []string

	// Scan results/ for blog-related JSON files
	resultsDir := cfg.OutputDir
	if resultsDir == "" {
		resultsDir = "results"
	}
	entries, _ := os.ReadDir(resultsDir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if !strings.Contains(strings.ToLower(e.Name()), "blog") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(resultsDir, e.Name()))
		if err != nil {
			continue
		}
		var doc map[string]interface{}
		if err := json.Unmarshal(data, &doc); err != nil {
			continue
		}
		if title, ok := doc["title"].(string); ok && title != "" {
			titles = append(titles, title)
		}
	}

	// Try Shopify article titles if configured
	if cfg.ShopifyStore != "" && cfg.ShopifyAccessToken != "" {
		blogID, err := shopifyFindBlog(cfg)
		if err == nil {
			data, err := shopifyRequest(cfg, "GET", fmt.Sprintf("/blogs/%d/articles.json?limit=250", blogID), nil)
			if err == nil {
				var result struct {
					Articles []struct {
						Title string `json:"title"`
					} `json:"articles"`
				}
				json.Unmarshal(data, &result)
				for _, a := range result.Articles {
					if a.Title != "" {
						titles = append(titles, a.Title)
					}
				}
			}
		}
	}

	return titles
}

// seoKeywordCovered checks if any existing content title contains the keyword.
func seoKeywordCovered(keyword string, titles []string) bool {
	kwLower := strings.ToLower(keyword)
	kwWords := strings.Fields(kwLower)
	for _, title := range titles {
		titleLower := strings.ToLower(title)
		// Check if most keyword words appear in the title
		matches := 0
		for _, w := range kwWords {
			if strings.Contains(titleLower, w) {
				matches++
			}
		}
		// If more than half the keyword words match, consider it covered
		if len(kwWords) > 0 && matches*2 >= len(kwWords) {
			return true
		}
	}
	return false
}

// seoBestGap picks the best keyword to write about next.
// Prefers high volume + easy difficulty.
func seoBestGap(gaps []SEOKeywordEntry) *SEOKeywordEntry {
	if len(gaps) == 0 {
		return nil
	}

	volScore := map[string]int{"high": 3, "medium": 2, "low": 1, "-": 0}
	diffScore := map[string]int{"easy": 3, "medium": 2, "hard": 1, "-": 0}

	best := &gaps[0]
	bestScore := volScore[best.Volume] + diffScore[best.Difficulty]

	for i := 1; i < len(gaps); i++ {
		score := volScore[gaps[i].Volume] + diffScore[gaps[i].Difficulty]
		if score > bestScore {
			best = &gaps[i]
			bestScore = score
		}
	}
	return best
}

// ── CLI Entry Points ───────────────────────────────────────

func runSEOKeywords(cfg *Config, cmd *Command) {
	if cmd.BlogBody == "" {
		log.Fatal("[ERROR] blogBody required — comma-separated seed keywords (e.g., \"chill streetwear, casual fashion\")")
	}
	seoResearchKeywords(cfg, cmd.BlogBody)
}

func runSEORankings(cfg *Config) {
	seoRankReport(cfg)
}

func runSEOUpdateRank(cfg *Config, cmd *Command) {
	if cmd.BlogTitle == "" {
		log.Fatal("[ERROR] blogTitle required — the keyword to update")
	}
	if cmd.BatchCount <= 0 {
		log.Fatal("[ERROR] batchCount required — the position number (e.g., 15)")
	}
	seoUpdateRanking(cfg, cmd.BlogTitle, cmd.BatchCount)
}

func runSEOTrack(cfg *Config, cmd *Command) {
	if cmd.BlogBody == "" {
		log.Fatal("[ERROR] blogBody required — comma-separated keywords to track")
	}
	seoTrackRankings(cfg, cmd.BlogBody)
}

func runSEOGaps(cfg *Config) {
	seoContentGaps(cfg)
}
