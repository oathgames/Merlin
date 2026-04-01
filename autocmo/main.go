package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const appVersion = "0.1.2"
const updateURL = "https://github.com/oathgames/AutoCMO/releases/latest/download"

// Config holds all pipeline settings, loaded from autocmo-config.json
type Config struct {
	// Provider selection — "auto" or omit to pick based on which keys are present
	VideoProvider string `json:"videoProvider"` // "fal", "veo", "arcads", "heygen", or "" (auto)
	FalModel      string `json:"falModel"`      // fal.ai model: "kling", "veo", "seedance", "minimax", "wan"
	ImageProvider string `json:"imageProvider"` // "gemini" or "" (auto)
	VoiceProvider string `json:"voiceProvider"` // "elevenlabs" or "" (auto)

	// API keys — only fill in the ones you use
	FalAPIKey        string `json:"falApiKey"`        // fal.ai — unified video (Kling, Veo, Seedance, etc.)
	GoogleAPIKey     string `json:"googleApiKey"`      // Google — Gemini (images, scripts, QA) + Veo (video)
	ElevenLabsAPIKey string `json:"elevenLabsApiKey"`  // ElevenLabs — voiceover
	ArcadsAPIKey     string `json:"arcadsApiKey"`      // Optional override
	HeyGenAPIKey     string `json:"heygenApiKey"`      // Optional override

	// Voice settings
	ElevenLabsVoiceID string `json:"elevenLabsVoiceId"`

	// Slack
	SlackWebhookURL string `json:"slackWebhookUrl"`
	SlackBotToken   string `json:"slackBotToken"`
	SlackChannel    string `json:"slackChannel"`

	// Meta Ads
	MetaAccessToken string `json:"metaAccessToken"` // System User token from Business Manager
	MetaAdAccountID string `json:"metaAdAccountId"` // act_XXXXXXXXX
	MetaPageID      string `json:"metaPageId"`      // Facebook Page ID
	MetaPixelID     string `json:"metaPixelId"`     // Pixel ID (optional)

	// TikTok Ads
	TikTokAccessToken  string `json:"tiktokAccessToken"`  // TikTok Marketing API access token
	TikTokAdvertiserID string `json:"tiktokAdvertiserId"` // Advertiser account ID
	TikTokPixelID      string `json:"tiktokPixelId"`      // TikTok Pixel ID (optional)

	// Shopify (SEO blog)
	ShopifyStore       string `json:"shopifyStore"`       // e.g., "shopnorthswell" (without .myshopify.com)
	ShopifyAccessToken string `json:"shopifyAccessToken"` // Admin API access token



	// Product
	ProductName        string `json:"productName"`
	ProductURL         string `json:"productUrl"`
	ProductDescription string `json:"productDescription"`
	OutputDir          string `json:"outputDir"`

	// Quality gate
	QualityGate bool `json:"qualityGate"` // Enable/disable QA gates (default true)
	MaxRetries  int  `json:"maxRetries"`  // Max retries per step (default 3)
}

// Command is the structured input Claude sends to control the pipeline.
// All fields are optional — unset fields use config defaults.
type Command struct {
	// What to do
	Action string `json:"action"` // "generate" (default), "image", "dry-run", "setup", "install"
	Mode   string `json:"mode,omitempty"` // "talking-head", "product-showcase", "auto" — Claude picks this

	// Brand/product context (Claude resolves these from folder structure)
	Brand   string `json:"brand,omitempty"`   // e.g., "madchill"
	Product string `json:"product,omitempty"` // e.g., "cream-set"

	// Video overrides
	Script      string `json:"script,omitempty"`      // Custom script text (bypasses Arcads auto-script)
	Format      string `json:"format,omitempty"`      // "9:16" (vertical), "16:9" (landscape), "1:1" (square)
	Language    string `json:"language,omitempty"`     // "en", "es", "fr", "de", etc.
	ProductHook string `json:"productHook,omitempty"` // One-line product angle/focus for this video

	// Voice overrides
	VoiceID    string  `json:"voiceId,omitempty"`    // ElevenLabs voice ID override
	VoiceStyle string  `json:"voiceStyle,omitempty"` // "casual", "energetic", "serious", "warm"
	Stability  float64 `json:"stability,omitempty"`  // 0.0–1.0, lower = more expressive
	SkipVoice  bool    `json:"skipVoice,omitempty"`  // true = no voiceover

	// Slack overrides
	SlackMessage string `json:"slackMessage,omitempty"` // Custom message above the embed
	SkipSlack    bool   `json:"skipSlack,omitempty"`    // true = generate only, don't post

	// Provider override (overrides config for this run)
	Provider string `json:"provider,omitempty"` // "fal", "veo", "arcads", "heygen", "gemini", "elevenlabs"
	FalModel string `json:"falModel,omitempty"` // "kling", "veo", "seedance", "minimax", "wan"
	Duration int    `json:"duration,omitempty"` // Video duration in seconds (default 5)

	// Image generation
	ImagePrompt  string `json:"imagePrompt,omitempty"`  // Custom prompt for image generation
	ImageCount   int    `json:"imageCount,omitempty"`   // Number of images to generate (default 1, max 4)
	ImageFormat  string `json:"imageFormat,omitempty"`  // "portrait" (4:5), "square" (1:1), "both" (default: both)
	ImageModel   string `json:"imageModel,omitempty"`   // "flux" (default), "ideogram", "recraft"

	// Reference images
	ReferenceImages []string `json:"referenceImages,omitempty"` // Specific image file paths
	ReferencesDir   string   `json:"referencesDir,omitempty"`   // Directory to scan for reference images

	// HeyGen avatar
	AvatarID string `json:"avatarId,omitempty"` // HeyGen avatar ID (use list-avatars to find)

	// Voice cloning
	VoiceSamples []string `json:"voiceSamples,omitempty"` // Audio file paths for cloning
	VoiceSampleDir string `json:"voiceSampleDir,omitempty"` // Directory of audio samples
	VoiceName    string   `json:"voiceName,omitempty"`     // Name for the cloned voice
	DeleteVoice  string   `json:"deleteVoice,omitempty"`   // Voice ID to delete

	// Meta Ads
	AdImagePath   string  `json:"adImagePath,omitempty"`   // Path to image for ad creative
	AdVideoPath   string  `json:"adVideoPath,omitempty"`   // Path to video for ad creative
	AdHeadline    string  `json:"adHeadline,omitempty"`    // Ad headline
	AdBody        string  `json:"adBody,omitempty"`        // Ad primary text
	AdLink        string  `json:"adLink,omitempty"`        // Destination URL
	CampaignName  string  `json:"campaignName,omitempty"`  // Campaign name
	DailyBudget   float64 `json:"dailyBudget,omitempty"`   // Daily budget in dollars (default 5)
	AdID          string  `json:"adId,omitempty"`          // For kill/duplicate operations
	CampaignID    string  `json:"campaignId,omitempty"`    // Target campaign for duplication

	// Blog / SEO
	BlogTitle   string `json:"blogTitle,omitempty"`   // Blog post title
	BlogBody    string `json:"blogBody,omitempty"`    // Blog post HTML body
	BlogTags    string `json:"blogTags,omitempty"`    // Comma-separated tags
	BlogImage   string `json:"blogImage,omitempty"`   // Image URL or local path for featured image
	BlogSummary string `json:"blogSummary,omitempty"` // Meta description / excerpt (150-160 chars)

	// Batch
	BatchCount int `json:"batchCount,omitempty"` // Number of variations to generate in parallel (default 1, max 5)

	// Install
	InstallDir string `json:"installDir,omitempty"` // Target directory for --install

	// Maintenance
	ArchiveDays int `json:"archiveDays,omitempty"` // Move results older than N days to archive (default 30)

	// Music
	MusicDir  string `json:"musicDir,omitempty"`  // Directory with background music tracks
	SkipMusic bool   `json:"skipMusic,omitempty"` // true = no background music

	// Testing
	Test bool `json:"test,omitempty"` // true = skip video API, use placeholder
}

func main() {
	configPath := flag.String("config", "", "Path to autocmo-config.json (default: next to this exe)")
	dryRun := flag.Bool("dry-run", false, "Validate config without calling APIs")
	setup := flag.Bool("setup", false, "Print setup instructions")
	testMode := flag.Bool("test", false, "Test mode — skip video generation, use placeholder, test voiceover + Slack")
	imageMode := flag.Bool("image", false, "Generate product ad images instead of video")
	installDir := flag.String("install", "", "Create a ready-to-use AutoCMO project folder at this path")
	cmdJSON := flag.String("cmd", "", "JSON command from Claude (overrides all other flags)")
	cmdFile := flag.String("cmd-file", "", "Path to JSON command file (alternative to --cmd for escaping issues)")
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("AutoCMO Pipeline v%s\n", appVersion)
		return
	}

	// If --cmd-file provided, read JSON from file
	if *cmdFile != "" && *cmdJSON == "" {
		data, err := os.ReadFile(*cmdFile)
		if err != nil {
			log.Fatalf("[ERROR] Cannot read --cmd-file: %v", err)
		}
		s := strings.TrimSpace(string(data))
		cmdJSON = &s
	}

	// Install mode — create distribution folder and exit
	if *installDir != "" {
		if err := installProject(*installDir); err != nil {
			log.Fatalf("[ERROR] Install failed: %v", err)
		}
		return
	}

	// If Claude sent a JSON command, parse it and route
	if *cmdJSON != "" {
		var cmd Command
		if err := json.Unmarshal([]byte(*cmdJSON), &cmd); err != nil {
			log.Fatalf("[ERROR] Invalid --cmd JSON: %v", err)
		}

		// Install action doesn't need config
		if cmd.Action == "install" {
			dir := cmd.InstallDir
			if dir == "" {
				dir = "."
			}
			if err := installProject(dir); err != nil {
				log.Fatalf("[ERROR] Install failed: %v", err)
			}
			return
		}

		cfg, err := loadConfig(*configPath)
		if err != nil {
			log.Fatalf("[ERROR] %v", err)
		}
		valMode := "video"
		if cmd.Action == "image" {
			valMode = "image"
		} else if cmd.Test {
			valMode = "test"
		}
		if errs := validateConfig(cfg, valMode); len(errs) > 0 {
			fmt.Println("[ERROR] Config validation failed:")
			for _, e := range errs {
				fmt.Printf("  - %s\n", e)
			}
			os.Exit(1)
		}
		switch cmd.Action {
		case "dry-run":
			fmt.Println("[OK] Config valid. All API keys present.")
			fmt.Printf("  Product: %s\n", cfg.ProductName)
		case "setup":
			printSetup()
		case "image":
			runImagePipeline(cfg, &cmd)
		case "clone-voice":
			runCloneVoice(cfg, &cmd, *configPath)
		case "list-voices":
			if err := elevenLabsListVoices(cfg); err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
		case "meta-push":
			runMetaPush(cfg, &cmd)
		case "meta-insights":
			runMetaInsights(cfg, &cmd)
		case "meta-lookalike":
			if cmd.AdID == "" {
				log.Fatal("[ERROR] adId required — the massive winner ad to create lookalike from")
			}
			if cfg.MetaPixelID == "" {
				log.Fatal("[ERROR] metaPixelId required for lookalike audiences")
			}
			lookalikeID, err := metaCreateLookalike(cfg, cmd.AdID)
			if err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Lookalike audience created: %s\n", lookalikeID)
		case "meta-kill":
			if cmd.AdID == "" {
				log.Fatal("[ERROR] adId required")
			}
			if err := metaPauseAd(cfg, cmd.AdID); err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Killed ad: %s\n", cmd.AdID)
		case "meta-duplicate":
			if cmd.AdID == "" || cmd.CampaignID == "" {
				log.Fatal("[ERROR] adId and campaignId required")
			}
			newID, err := metaDuplicateAd(cfg, cmd.AdID, cmd.CampaignID)
			if err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Duplicated ad %s → %s (in campaign %s)\n", cmd.AdID, newID, cmd.CampaignID)
		case "meta-setup":
			runMetaSetup(cfg)
		case "meta-retarget":
			if cmd.AdID == "" {
				log.Fatal("[ERROR] adId required — the scaling winner to copy into retargeting")
			}
			if cfg.MetaPixelID == "" {
				log.Fatal("[ERROR] metaPixelId required for retargeting")
			}
			adID, err := metaCopyWinnerToRetargeting(cfg, cmd.AdID)
			if err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Winner copied to retargeting: %s\n", adID)
		case "blog-post":
			runBlogPost(cfg, &cmd)
		case "blog-list":
			runBlogList(cfg)
		case "seo-audit":
			if cfg.ShopifyStore == "" || cfg.ShopifyAccessToken == "" {
				log.Fatal("[ERROR] shopifyStore and shopifyAccessToken required")
			}
			if err := shopifySEOAudit(cfg); err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
		case "competitor-scan":
			runCompetitorScan(cfg, &cmd)
		case "seo-fix-alt":
			if cmd.AdID == "" || cmd.CampaignID == "" || cmd.BlogTitle == "" {
				log.Fatal("[ERROR] adId (product ID), campaignId (image ID), blogTitle (alt text) required")
			}
			var pid, iid int64
			fmt.Sscanf(cmd.AdID, "%d", &pid)
			fmt.Sscanf(cmd.CampaignID, "%d", &iid)
			if err := shopifyUpdateImageAlt(cfg, pid, iid, cmd.BlogTitle); err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Updated image %d alt text on product %d\n", iid, pid)
		case "meta-setup-retargeting":
			if cfg.MetaPixelID == "" {
				log.Fatal("[ERROR] metaPixelId required for retargeting audiences")
			}
			sv, ca, vc, err := metaEnsureRetargetingAudiences(cfg)
			if err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Site visitors audience: %s\n", sv)
			fmt.Printf("  Cart abandoners audience: %s\n", ca)
			fmt.Printf("  View content audience: %s\n", vc)
		case "tiktok-push":
			runTikTokPush(cfg, &cmd)
		case "tiktok-insights":
			runTikTokInsights(cfg, &cmd)
		case "tiktok-setup":
			runTikTokSetup(cfg)
		case "tiktok-kill":
			if cmd.AdID == "" {
				log.Fatal("[ERROR] adId required")
			}
			if err := tiktokPauseAd(cfg, cmd.AdID); err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Killed TikTok ad: %s\n", cmd.AdID)
		case "tiktok-duplicate":
			if cmd.AdID == "" || cmd.CampaignID == "" {
				log.Fatal("[ERROR] adId and campaignId required")
			}
			newID, err := tiktokDuplicateAd(cfg, cmd.AdID, cmd.CampaignID)
			if err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Duplicated TikTok ad %s → %s\n", cmd.AdID, newID)
		case "tiktok-lookalike":
			if cmd.AdID == "" {
				log.Fatal("[ERROR] adId required — the massive winner ad to create lookalike from")
			}
			if cfg.TikTokPixelID == "" {
				log.Fatal("[ERROR] tiktokPixelId required for lookalike audiences")
			}
			lookalikeID, err := tiktokCreateLookalike(cfg, cmd.AdID)
			if err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  TikTok lookalike audience created: %s\n", lookalikeID)
		case "list-avatars":
			if cfg.HeyGenAPIKey == "" {
				log.Fatal("[ERROR] heygenApiKey required — https://app.heygen.com/settings → API")
			}
			if err := heygenListAvatars(cfg); err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
		case "delete-voice":
			if cmd.DeleteVoice == "" {
				log.Fatal("[ERROR] deleteVoice field required — provide the voice ID to delete")
			}
			if err := elevenLabsDeleteVoice(cfg, cmd.DeleteVoice); err != nil {
				log.Fatalf("[ERROR] %v", err)
			}
			fmt.Printf("  Deleted voice: %s\n", cmd.DeleteVoice)
		case "version":
			fmt.Printf("AutoCMO Pipeline v%s\n", appVersion)
		case "update":
			runSelfUpdate()
		case "batch":
			runBatchPipeline(cfg, &cmd)
		case "archive":
			days := cmd.ArchiveDays
			if days <= 0 {
				days = 30
			}
			runArchive(cfg, days)
		default: // "generate" or empty
			runPipelineWithCommand(cfg, &cmd)
		}
		return
	}

	if *setup {
		printSetup()
		return
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("[ERROR] %v", err)
	}

	valMode := "video"
	if *imageMode {
		valMode = "image"
	} else if *testMode {
		valMode = "test"
	}
	if errs := validateConfig(cfg, valMode); len(errs) > 0 {
		fmt.Println("[ERROR] Config validation failed:")
		for _, e := range errs {
			fmt.Printf("  - %s\n", e)
		}
		fmt.Println("\nRun with --setup for instructions.")
		os.Exit(1)
	}

	if *dryRun {
		fmt.Println("[OK] Config valid. All API keys present.")
		fmt.Printf("  Product: %s\n", cfg.ProductName)
		fmt.Printf("  Output:  %s\n", cfg.OutputDir)
		return
	}

	if *imageMode {
		runImagePipeline(cfg, nil)
	} else if *testMode {
		runPipeline(cfg, &Command{Test: true})
	} else {
		runPipeline(cfg, nil)
	}
}

func loadConfig(path string) (*Config, error) {
	if path == "" {
		exe, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("cannot determine exe path: %w", err)
		}
		path = filepath.Join(filepath.Dir(exe), "autocmo-config.json")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read config at %s: %w\nRun with --setup for instructions", path, err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("invalid JSON in %s: %w", path, err)
	}

	// Resolve outputDir relative to the exe's own directory
	exeDir := filepath.Dir(path)

	// Defaults
	if cfg.ElevenLabsVoiceID == "" {
		cfg.ElevenLabsVoiceID = "21m00Tcm4TlvDq8ikWAM" // Rachel
	}
	if cfg.OutputDir == "" {
		cfg.OutputDir = filepath.Join(exeDir, "results")
	} else if !filepath.IsAbs(cfg.OutputDir) {
		// Relative paths resolve from the exe's directory, not CWD
		cfg.OutputDir = filepath.Join(exeDir, cfg.OutputDir)
	}
	if cfg.ProductName == "" {
		cfg.ProductName = "My Product"
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 3
	}
	// QualityGate defaults to true — detect "not set" by checking raw JSON
	if !cfg.QualityGate {
		// Check if it was explicitly set to false vs just missing from JSON
		var raw map[string]interface{}
		json.Unmarshal(data, &raw)
		if _, exists := raw["qualityGate"]; !exists {
			cfg.QualityGate = true // Default ON
		}
	}

	return &cfg, nil
}

// resolveVideoProvider picks the video provider from command override, config, or auto-detect.
func resolveVideoProvider(cfg *Config, cmd *Command) string {
	// Command override first
	if cmd != nil && cmd.Provider != "" {
		switch cmd.Provider {
		case "fal", "veo", "arcads", "heygen":
			return cmd.Provider
		}
	}
	// Config explicit setting
	if cfg.VideoProvider != "" && cfg.VideoProvider != "auto" {
		return cfg.VideoProvider
	}
	// Auto-detect from keys (priority: fal > heygen > arcads > veo)
	if cfg.FalAPIKey != "" {
		return "fal"
	}
	if cfg.HeyGenAPIKey != "" {
		return "heygen"
	}
	if cfg.ArcadsAPIKey != "" {
		return "arcads"
	}
	if cfg.GoogleAPIKey != "" {
		return "veo"
	}
	return ""
}

// resolveImageProvider picks the image provider. fal.ai (Flux Pro) first — best quality.
func resolveImageProvider(cfg *Config, cmd *Command) string {
	if cmd != nil && cmd.Provider == "gemini" {
		return "gemini"
	}
	if cmd != nil && cmd.Provider == "fal" {
		return "fal"
	}
	if cfg.ImageProvider != "" && cfg.ImageProvider != "auto" {
		return cfg.ImageProvider
	}
	// fal.ai first — Flux Pro produces higher quality images than Gemini
	if cfg.FalAPIKey != "" {
		return "fal"
	}
	if cfg.GoogleAPIKey != "" {
		return "gemini"
	}
	return ""
}

// resolveVoiceProvider picks the voice provider.
func resolveVoiceProvider(cfg *Config, cmd *Command) string {
	if cmd != nil && cmd.Provider == "elevenlabs" {
		return "elevenlabs"
	}
	if cfg.VoiceProvider != "" && cfg.VoiceProvider != "auto" {
		return cfg.VoiceProvider
	}
	if cfg.ElevenLabsAPIKey != "" {
		return "elevenlabs"
	}
	return ""
}

func validateConfig(cfg *Config, mode string) []string {
	var errs []string

	if mode == "video" {
		vp := resolveVideoProvider(cfg, nil)
		if vp == "" {
			errs = append(errs, "no video provider configured — set falApiKey (recommended) or googleApiKey/arcadsApiKey/heygenApiKey")
		}
		switch vp {
		case "fal":
			if cfg.FalAPIKey == "" {
				errs = append(errs, "falApiKey is empty — get yours at https://fal.ai/dashboard/keys")
			}
		case "veo":
			if cfg.GoogleAPIKey == "" {
				errs = append(errs, "googleApiKey is empty — https://aistudio.google.com/apikey")
			}
		case "arcads":
			if cfg.ArcadsAPIKey == "" {
				errs = append(errs, "arcadsApiKey is empty — https://app.arcads.ai → Settings → API Keys")
			}
		case "heygen":
			if cfg.HeyGenAPIKey == "" {
				errs = append(errs, "heygenApiKey is empty — https://app.heygen.com/settings → API")
			}
		}
	}

	if mode == "image" {
		ip := resolveImageProvider(cfg, nil)
		if ip == "" {
			errs = append(errs, "no image provider — googleApiKey needed for Gemini: https://aistudio.google.com/apikey")
		}
	}

	if (mode == "video" || mode == "test") {
		vp := resolveVoiceProvider(cfg, nil)
		if vp == "" {
			// Voice is optional — warn, don't error
			fmt.Println("  [NOTE] No voice provider configured — voiceover will be skipped")
		}
	}

	// Slack is optional — only warn if partially configured
	if cfg.SlackWebhookURL != "" && cfg.SlackBotToken == "" {
		errs = append(errs, "slackBotToken is empty but slackWebhookUrl is set — need both for Slack posting")
	}
	return errs
}

// resolveReferences loads reference images from the command or the default references dir.
func resolveReferences(cfg *Config, cmd *Command) []ReferenceImage {
	// Specific images from command take priority
	if cmd != nil && len(cmd.ReferenceImages) > 0 {
		refs, err := loadSpecificImages(cmd.ReferenceImages)
		if err != nil {
			fmt.Printf("  [WARN] Cannot load reference images: %v\n", err)
			return nil
		}
		return refs
	}

	// Check command-specified dir, then config-relative default
	refsDir := ""
	if cmd != nil && cmd.ReferencesDir != "" {
		refsDir = cmd.ReferencesDir
	} else {
		// Default: "references/" relative to config dir's grandparent (project root)
		// Config is at .claude/tools/autocmo-config.json → project root is ../../
		refsDir = filepath.Join(cfg.OutputDir, "..", "assets", "brands", "references")
	}

	if refsDir != "" {
		refs, err := loadReferenceImages(refsDir)
		if err != nil {
			fmt.Printf("  [WARN] Cannot load references: %v\n", err)
		}
		return refs
	}
	return nil
}

// findAvatarAsset looks for an avatar in the brand's avatars/ folder.
// Searches assets/brands/<brand>/avatars/ for each brand found.
// Returns (path, type) where type is "video" (.mp4/.mov) or "photo" (.jpg/.png).
func findAvatarAsset(cfg *Config) (string, string) {
	// Try brand-specific avatar directories first
	brandsDir := filepath.Join(cfg.OutputDir, "..", "assets", "brands")
	brandEntries, _ := os.ReadDir(brandsDir)
	for _, brand := range brandEntries {
		if !brand.IsDir() {
			continue
		}
		avatarDir := filepath.Join(brandsDir, brand.Name(), "avatars")
		path, atype := scanAvatarDir(avatarDir)
		if path != "" {
			return path, atype
		}
	}
	// Fallback: check legacy path
	avatarDir := filepath.Join(cfg.OutputDir, "..", "assets", "brands", "avatars")
	return scanAvatarDir(avatarDir)
}

// scanAvatarDir searches a directory for avatar files, preferring video over photo.
func scanAvatarDir(avatarDir string) (string, string) {
	entries, err := os.ReadDir(avatarDir)
	if err != nil {
		return "", ""
	}
	var photoPath string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		switch ext {
		case ".mp4", ".mov", ".webm":
			return filepath.Join(avatarDir, e.Name()), "video"
		case ".png", ".jpg", ".jpeg", ".webp":
			if photoPath == "" {
				photoPath = filepath.Join(avatarDir, e.Name())
			}
		}
	}
	if photoPath != "" {
		return photoPath, "photo"
	}
	return "", ""
}

// findAvatarPhoto is a convenience wrapper for backward compat.
func findAvatarPhoto(cfg *Config) string {
	path, _ := findAvatarAsset(cfg)
	return path
}

func runPipelineWithCommand(cfg *Config, cmd *Command) {
	// Apply command overrides to config
	if cmd.VoiceID != "" {
		cfg.ElevenLabsVoiceID = cmd.VoiceID
	}
	if cmd.ProductHook != "" {
		cfg.ProductDescription = cmd.ProductHook
	}
	runPipeline(cfg, cmd)
}

func runPipeline(cfg *Config, cmd *Command) {
	started := time.Now()
	fmt.Println("============================================================")
	fmt.Printf("AutoCMO — %s\n", cfg.ProductName)
	if cmd != nil && cmd.ProductHook != "" {
		fmt.Printf("  Angle: %s\n", cmd.ProductHook)
	}
	fmt.Println("============================================================")

	// Create a unique folder for this run: Results/ugc_20260331_140532/
	runID := time.Now().Format("20060102_150405")
	runDir := filepath.Join(cfg.OutputDir, "ad_"+runID)
	if err := os.MkdirAll(runDir, 0755); err != nil {
		log.Fatalf("[ERROR] Cannot create run dir: %v", err)
	}
	fmt.Printf("  Output folder: %s\n", runDir)

	// Load reference images (used for script generation + video prompt enrichment)
	refs := resolveReferences(cfg, cmd)
	if len(refs) > 0 {
		fmt.Printf("  References: %d image(s) loaded\n", len(refs))
	}

	// Check for avatar asset (video or photo)
	avatarPath, avatarType := findAvatarAsset(cfg)
	if avatarPath != "" {
		if avatarType == "video" {
			fmt.Printf("  Avatar: %s (video lip-sync mode)\n", filepath.Base(avatarPath))
		} else {
			fmt.Printf("  Avatar: %s (talking-head photo mode)\n", filepath.Base(avatarPath))
		}
	}

	isTest := cmd != nil && cmd.Test
	skipVoice := cmd != nil && cmd.SkipVoice
	qaEnabled := cfg.QualityGate
	maxRetries := cfg.MaxRetries
	videoPath := filepath.Join(runDir, "video.mp4")
	var voiceoverPath string
	var scriptText string
	var videoMeta *VideoMeta
	qaReport := &QAReport{}

	if qaEnabled {
		fmt.Println("  Quality gate: ON (max retries:", maxRetries, ")")
	}

	// ── Step 1: Generate Ad Script (with QA retry) ──────────────
	if cmd != nil && cmd.Script != "" {
		scriptText = cmd.Script
		fmt.Println("\n[1/5] Using provided script")
		// Still QA-check even user-provided scripts
		if qaEnabled {
			result := qaScript(cfg, scriptText, refs)
			qaReport.Script = &result
			if !result.Pass {
				fmt.Printf("  ⚠ Script QA warning: %s\n", result.Reason)
				// Don't reject user-provided scripts, just warn
			} else {
				scoreStr := ""
				if result.Score != nil {
					scoreStr = fmt.Sprintf(" (%.0f/10)", *result.Score)
				}
				fmt.Printf("  ✓ Script QA passed%s\n", scoreStr)
			}
		}
	} else if !skipVoice && cfg.GoogleAPIKey != "" {
		fmt.Println("\n[1/5] Writing ad script via Gemini...")
		feedback := ""
		for attempt := 1; attempt <= maxRetries; attempt++ {
			var err error
			if feedback != "" {
				scriptText, err = generateUGCScript(cfg, refs, 15, feedback)
			} else {
				scriptText, err = generateUGCScript(cfg, refs, 15)
			}
			if err != nil {
				fmt.Printf("  [WARN] Script generation failed: %v\n", err)
				scriptText = testScript(cfg)
				break
			}

			if !qaEnabled {
				break
			}

			result := qaScript(cfg, scriptText, refs)
			result.Attempts = attempt
			qaReport.Script = &result

			if result.Pass {
				scoreStr := ""
				if result.Score != nil {
					scoreStr = fmt.Sprintf(" (%.0f/10)", *result.Score)
				}
				fmt.Printf("  ✓ Script QA passed%s\n", scoreStr)
				break
			}

			fmt.Printf("  ✗ Script QA failed (attempt %d/%d): %s\n", attempt, maxRetries, result.Reason)
			if attempt < maxRetries {
				feedback = result.Reason
				fmt.Println("  Regenerating with feedback...")
			} else {
				fmt.Println("  Max retries reached — using last script")
			}
		}
	} else {
		scriptText = testScript(cfg)
		fmt.Println("\n[1/5] Using default script")
	}

	// Save script
	if scriptText != "" {
		scriptPath := filepath.Join(runDir, "script.txt")
		os.WriteFile(scriptPath, []byte(scriptText), 0644)
		fmt.Printf("  Script: %s\n", scriptPath)
	}

	// ── Step 2: Generate Voiceover (with QA retry) ───────────────
	if !skipVoice && scriptText != "" && resolveVoiceProvider(cfg, cmd) != "" {
		fmt.Println("\n[2/5] Generating voiceover via ElevenLabs...")
		for attempt := 1; attempt <= maxRetries; attempt++ {
			voiceoverPath = filepath.Join(runDir, "voiceover.mp3")
			if err := elevenLabsSpeak(cfg, cmd, scriptText, voiceoverPath); err != nil {
				fmt.Printf("  [WARN] ElevenLabs failed: %v\n", err)
				voiceoverPath = ""
				break
			}
			fmt.Printf("  Saved: %s\n", voiceoverPath)

			if !qaEnabled {
				break
			}

			result := qaVoiceover(voiceoverPath)
			result.Attempts = attempt
			qaReport.Voiceover = &result

			if result.Pass {
				durStr := ""
				if d, ok := result.Checks["duration"]; ok {
					durStr = fmt.Sprintf(" (%.1fs)", d.(float64))
				}
				fmt.Printf("  ✓ Voiceover QA passed%s\n", durStr)
				break
			}

			fmt.Printf("  ✗ Voiceover QA failed (attempt %d/%d): %s\n", attempt, maxRetries, result.Reason)
			if attempt < maxRetries {
				fmt.Println("  Regenerating voiceover...")
			} else {
				fmt.Println("  Max retries reached — using last voiceover")
			}
		}
	} else if skipVoice {
		fmt.Println("\n[2/5] Skipping voiceover (disabled)")
	} else {
		fmt.Println("\n[2/5] Skipping voiceover (no voice provider)")
	}

	// ── Step 3: Generate Video (with QA retry) ───────────────────
	videoProvider := resolveVideoProvider(cfg, cmd)

	// Mode-based routing override — Claude picks the right pipeline
	contentMode := "product-showcase"
	if cmd != nil && cmd.Mode != "" {
		contentMode = cmd.Mode
	}
	if contentMode == "talking-head" && cfg.HeyGenAPIKey != "" {
		videoProvider = "heygen"
	}

	if isTest {
		fmt.Println("\n[3/5] TEST MODE — creating placeholder video...")
		videoMeta = &VideoMeta{
			ID:          "test-" + runID,
			Status:      "completed",
			Script:      scriptText,
			VideoFormat: "9:16",
			Duration:    30,
			Model:       "test/placeholder",
		}
		if err := createPlaceholderVideo(videoPath); err != nil {
			log.Fatalf("[ERROR] Cannot create placeholder: %v", err)
		}
		fmt.Printf("  Placeholder saved: %s\n", videoPath)
	} else {
		// Build video prompt
		videoPrompt := fmt.Sprintf(
			"UGC-style social media video for %s. %s. "+
				"Natural handheld camera, authentic lifestyle feel, someone using or wearing the product. "+
				"Vertical format, 8 seconds, vibrant and aspirational.",
			cfg.ProductName, cfg.ProductDescription,
		)
		if cmd != nil && cmd.ProductHook != "" {
			videoPrompt = cmd.ProductHook
		}

		// Enrich prompt with reference images
		if len(refs) > 0 {
			fmt.Printf("  Enhancing video prompt with %d reference(s)...\n", len(refs))
			enhanced, err := geminiDescribeForVideo(cfg, videoPrompt, refs)
			if err != nil {
				fmt.Printf("  [WARN] Could not enhance prompt: %v (using original)\n", err)
			} else {
				videoPrompt = enhanced
			}
		}

		for attempt := 1; attempt <= maxRetries; attempt++ {
			switch videoProvider {
			case "fal":
				falModel := cfg.FalModel
				if falModel == "" {
					falModel = "veo"
				}
				if cmd != nil && cmd.FalModel != "" {
					falModel = cmd.FalModel
				} else if cmd != nil && cmd.Provider != "" && cmd.Provider != "fal" {
					if _, ok := falVideoModels[cmd.Provider]; ok {
						falModel = cmd.Provider
					}
				}
				dur := 5
				if cmd != nil && cmd.Duration > 0 {
					dur = cmd.Duration
				}

				// Priority: Avatar (lip-sync) > Image-to-video > Text-to-video
				mode := "text-to-video"
				avatarDone := false

				if avatarPath != "" && avatarType == "video" && voiceoverPath != "" {
					// ── VIDEO LIP-SYNC: real video + voiceover → lip-synced output ──
					fmt.Printf("\n[3/7] Lip-syncing video avatar (attempt %d)...\n", attempt)
					fmt.Printf("  Uploading video clip + voiceover...\n")

					videoURL, err1 := falUploadFile(cfg, avatarPath)
					audioURL, err2 := falUploadFile(cfg, voiceoverPath)

					if err1 == nil && err2 == nil {
						if err := falLipSync(cfg, videoURL, audioURL, videoPath); err == nil {
							mode = "video-lipsync"
							avatarDone = true
							videoMeta = &VideoMeta{
								ID:          "fal-" + runID,
								Status:      "completed",
								Script:      scriptText,
								VideoFormat: "9:16",
								Duration:    dur,
								Model:       "fal/kling-lipsync (video)",
							}
						} else {
							fmt.Printf("  [WARN] Lip-sync failed: %v — falling back\n", err)
						}
					} else {
						if err1 != nil {
							fmt.Printf("  [WARN] Video upload failed: %v\n", err1)
						}
						if err2 != nil {
							fmt.Printf("  [WARN] Audio upload failed: %v\n", err2)
						}
						fmt.Println("  Falling back...")
					}
				} else if avatarPath != "" && avatarType == "photo" && voiceoverPath != "" {
					// ── PHOTO AVATAR: photo + voiceover → animated talking head ──
					fmt.Printf("\n[3/7] Generating talking-head via fal.ai avatar (attempt %d)...\n", attempt)
					fmt.Printf("  Uploading avatar + voiceover...\n")

					avatarURL, err1 := falUploadFile(cfg, avatarPath)
					audioURL, err2 := falUploadFile(cfg, voiceoverPath)

					if err1 == nil && err2 == nil {
						if err := falGenerateAvatar(cfg, avatarURL, audioURL, videoPrompt, videoPath); err == nil {
							mode = "avatar-lipsync"
							avatarDone = true
							videoMeta = &VideoMeta{
								ID:          "fal-" + runID,
								Status:      "completed",
								Script:      scriptText,
								VideoFormat: "9:16",
								Duration:    dur,
								Model:       "fal/kling-avatar-v2 (photo)",
							}
						} else {
							fmt.Printf("  [WARN] Avatar generation failed: %v — falling back\n", err)
						}
					} else {
						if err1 != nil {
							fmt.Printf("  [WARN] Avatar upload failed: %v\n", err1)
						}
						if err2 != nil {
							fmt.Printf("  [WARN] Audio upload failed: %v\n", err2)
						}
						fmt.Println("  Falling back...")
					}
				}

				if !avatarDone {
					// Try image-to-video if references exist
					if len(refs) > 0 {
						if _, hasI2V := falI2VModels[falModel]; hasI2V {
							fmt.Printf("\n[3/7] Uploading reference for image-to-video...\n")
							bestRef := refs[0]
							for _, r := range refs {
								if strings.Contains(strings.ToLower(r.Path), "screenshot") {
									bestRef = r
									break
								}
							}
							if uploadedURL, err := falUploadFile(cfg, bestRef.Path); err == nil {
								mode = "image-to-video"
								fmt.Printf("  Generating via fal.ai/%s (%s, %ds)...\n", falModel, mode, dur)
								if err := falGenerateImageToVideo(cfg, falModel, videoPrompt, uploadedURL, videoPath, dur); err != nil {
									fmt.Printf("  [WARN] i2v failed: %v — falling back to t2v\n", err)
									mode = "text-to-video"
								}
							}
						}
					}

					if mode == "text-to-video" {
						fmt.Printf("\n[3/7] Generating via fal.ai/%s (%s, %ds, attempt %d)...\n", falModel, mode, dur, attempt)
						if err := falGenerateVideo(cfg, falModel, videoPrompt, videoPath, dur); err != nil {
							log.Fatalf("[ERROR] fal.ai failed: %v", err)
						}
					}

					videoMeta = &VideoMeta{
						ID:          "fal-" + runID,
						Status:      "completed",
						Script:      scriptText,
						VideoFormat: "9:16",
						Duration:    dur,
						Model:       "fal/" + falModel + " (" + mode + ")",
					}
				}

			case "veo":
				fmt.Printf("\n[3/5] Generating ad video via Google Veo (attempt %d)...\n", attempt)
				if err := veoGenerateVideo(cfg, videoPrompt, videoPath); err != nil {
					log.Fatalf("[ERROR] Veo failed: %v", err)
				}
				videoMeta = &VideoMeta{
					ID:          "veo-" + runID,
					Status:      "completed",
					Script:      scriptText,
					VideoFormat: "9:16",
					Duration:    8,
					Model:       "google/veo-direct",
				}

			case "heygen":
				fmt.Printf("\n[3/5] Generating ad video via HeyGen (attempt %d)...\n", attempt)
				var err error
				videoMeta, err = heygenGenerate(cfg, cmd, videoPrompt)
				if err != nil {
					log.Fatalf("[ERROR] HeyGen failed: %v", err)
				}
				videoMeta.Model = "heygen"
				videoURL := videoMeta.VideoURL
				if videoURL == "" {
					videoURL = videoMeta.DownloadURL
				}
				if videoURL == "" {
					log.Fatal("[ERROR] No video URL in HeyGen response")
				}
				if err := downloadFile(videoURL, videoPath); err != nil {
					log.Fatalf("[ERROR] Failed to download video: %v", err)
				}
				fmt.Printf("  Saved: %s\n", videoPath)

			case "arcads":
				fmt.Printf("\n[3/5] Generating ad video via Arcads (attempt %d)...\n", attempt)
				var err error
				videoMeta, err = arcadsGenerate(cfg, cmd)
				if err != nil {
					log.Fatalf("[ERROR] Arcads failed: %v", err)
				}
				videoMeta.Model = "arcads"
				videoURL := videoMeta.VideoURL
				if videoURL == "" {
					videoURL = videoMeta.DownloadURL
				}
				if videoURL == "" {
					log.Fatal("[ERROR] No video URL in Arcads response")
				}
				if err := downloadFile(videoURL, videoPath); err != nil {
					log.Fatalf("[ERROR] Failed to download video: %v", err)
				}
				fmt.Printf("  Saved: %s\n", videoPath)

			default:
				log.Fatalf("[ERROR] No video provider configured. Set videoProvider or add an API key.")
			}

			if !qaEnabled {
				break
			}

			result := qaVideo(cfg, videoPath, refs)
			result.Attempts = attempt
			qaReport.Video = &result

			if result.Pass {
				scoreStr := ""
				if result.Score != nil {
					scoreStr = fmt.Sprintf(" (visual: %.0f/10)", *result.Score)
				}
				fmt.Printf("  ✓ Video QA passed%s\n", scoreStr)
				break
			}

			fmt.Printf("  ✗ Video QA failed (attempt %d/%d): %s\n", attempt, maxRetries, result.Reason)
			if attempt < maxRetries {
				videoPrompt += " Avoid: " + result.Reason
				fmt.Println("  Regenerating video with adjusted prompt...")
			} else {
				fmt.Println("  Max retries reached — using last video")
			}
		}
	}

	// Save metadata
	metaPath := filepath.Join(runDir, "metadata.json")
	if metaJSON, err := json.MarshalIndent(videoMeta, "", "  "); err == nil {
		os.WriteFile(metaPath, metaJSON, 0644)
	}

	// ── Step 4: Merge Video + Audio (with QA retry) ──────────────
	// Skip merge for avatar pipeline — Kling Avatar bakes audio into the video
	isAvatarVideo := videoMeta != nil && strings.Contains(videoMeta.Model, "avatar")
	finalPath := videoPath
	if voiceoverPath != "" && !isAvatarVideo {
		fmt.Println("\n[4/5] Merging video + voiceover...")
		mergedPath := filepath.Join(runDir, "final.mp4")

		for attempt := 1; attempt <= maxRetries; attempt++ {
			if err := mergeVideoAudio(videoPath, voiceoverPath, mergedPath); err != nil {
				fmt.Printf("  [WARN] Merge failed: %v\n", err)
				if attempt == maxRetries {
					fmt.Println("  Posting video and audio separately instead")
				}
				continue
			}

			if !qaEnabled {
				finalPath = mergedPath
				break
			}

			result := qaFinal(mergedPath, videoPath, voiceoverPath)
			result.Attempts = attempt
			qaReport.Final = &result

			if result.Pass {
				finalPath = mergedPath
				fmt.Printf("  ✓ Final QA passed\n")
				break
			}

			fmt.Printf("  ✗ Final QA failed (attempt %d/%d): %s\n", attempt, maxRetries, result.Reason)
			if attempt == maxRetries {
				fmt.Println("  Falling back to separate video + audio")
			}
		}
	} else {
		fmt.Println("\n[4/5] Skipping merge (no voiceover)")
	}

	// ── Step 4b: Mix Music Bed ──────────────────────────────────
	skipMusic := cmd != nil && cmd.SkipMusic
	if !skipMusic && finalPath != "" {
		// Find music directory: command override > default assets/music/
		musicDir := ""
		if cmd != nil && cmd.MusicDir != "" {
			musicDir = cmd.MusicDir
		} else {
			musicDir = filepath.Join(cfg.OutputDir, "..", "assets", "music")
		}
		ensureMusicPack(musicDir)
		track := pickMusicTrack(musicDir)
		if track != "" {
			musicPath := filepath.Join(runDir, "with_music.mp4")
			if err := mixMusicBed(finalPath, track, musicPath); err != nil {
				fmt.Printf("  [WARN] Music mix failed: %v (continuing without)\n", err)
			} else {
				finalPath = musicPath
			}
		} else {
			fmt.Println("  No music tracks found — skipping music bed")
		}
	}

	// ── Step 5: Burn Captions ────────────────────────────────────
	if scriptText != "" && finalPath != "" {
		fmt.Println("\n[5/7] Burning captions into video...")
		captionedPath := filepath.Join(runDir, "captioned.mp4")
		if err := burnCaptions(finalPath, scriptText, captionedPath); err != nil {
			fmt.Printf("  [WARN] Caption burn failed: %v (continuing without)\n", err)
		} else {
			finalPath = captionedPath
		}
	} else {
		fmt.Println("\n[5/7] Skipping captions (no script)")
	}

	// ── Step 6: Platform Cuts ────────────────────────────────────
	fmt.Println("\n[6/7] Generating platform cuts...")
	platformCuts, err := cutPlatformVersions(finalPath, runDir)
	if err != nil {
		fmt.Printf("  [WARN] Platform cuts failed: %v\n", err)
	} else {
		fmt.Printf("  Generated %d platform version(s)\n", len(platformCuts))
	}

	// Save QA report
	if qaEnabled {
		saveQAReport(runDir, qaReport)
		fmt.Printf("  QA report: %s\n", filepath.Join(runDir, "qa_report.json"))
	}

	// ── Step 7: Post to Slack ────────────────────────────────────
	skipPost := cmd != nil && cmd.SkipSlack
	if !skipPost && cfg.SlackWebhookURL == "" {
		skipPost = true
		fmt.Println("\n[7/7] Skipping Slack (not configured)")
	}
	if !skipPost {
		fmt.Println("\n[7/7] Posting to Slack...")
		customMsg := ""
		if cmd != nil {
			customMsg = cmd.SlackMessage
		}
		uploadVoice := ""
		if finalPath == videoPath {
			uploadVoice = voiceoverPath
		}
		if err := slackPost(cfg, finalPath, uploadVoice, videoMeta, customMsg); err != nil {
			log.Fatalf("[ERROR] Slack post failed: %v", err)
		}
		fmt.Println("  Posted successfully!")
	} else {
		fmt.Println("\n[7/7] Skipping Slack (disabled)")
	}

	fmt.Println("\n============================================================")
	fmt.Printf("Pipeline complete in %s\n", time.Since(started).Round(time.Second))
	fmt.Printf("  Folder:    %s\n", runDir)
	fmt.Printf("  Master:    %s\n", finalPath)
	if voiceoverPath != "" {
		fmt.Printf("  Voiceover: %s\n", voiceoverPath)
	}
	if len(platformCuts) > 0 {
		fmt.Println("  Cuts:")
		for name, path := range platformCuts {
			fmt.Printf("    %s → %s\n", name, filepath.Base(path))
		}
	}
	fmt.Println("============================================================")
}

func runCloneVoice(cfg *Config, cmd *Command, configPath string) {
	fmt.Println("============================================================")
	fmt.Println("  Voice Cloning — ElevenLabs")
	fmt.Println("============================================================")

	if cfg.ElevenLabsAPIKey == "" {
		log.Fatal("[ERROR] elevenLabsApiKey required for voice cloning")
	}

	// Collect audio samples
	var samples []string

	// Specific files from command
	if len(cmd.VoiceSamples) > 0 {
		samples = cmd.VoiceSamples
	}

	// Scan a directory for audio files
	if cmd.VoiceSampleDir != "" {
		dirSamples, err := scanVoiceSamples(cmd.VoiceSampleDir)
		if err != nil {
			log.Fatalf("[ERROR] Cannot scan %s: %v", cmd.VoiceSampleDir, err)
		}
		samples = append(samples, dirSamples...)
	}

	// Default: check for a "voices/" folder at project root
	if len(samples) == 0 {
		defaultDir := filepath.Join(cfg.OutputDir, "..", "assets", "brands", "voices")
		if info, err := os.Stat(defaultDir); err == nil && info.IsDir() {
			dirSamples, err := scanVoiceSamples(defaultDir)
			if err == nil && len(dirSamples) > 0 {
				fmt.Printf("  Found %d sample(s) in voices/ folder\n", len(dirSamples))
				samples = dirSamples
			}
		}
	}

	if len(samples) == 0 {
		fmt.Println("\n[ERROR] No audio samples found.")
		fmt.Println("  Options:")
		fmt.Println("    1. Drop .mp3/.wav/.m4a files in the voices/ folder")
		fmt.Println("    2. Pass specific files: {\"voiceSamples\": [\"path/to/recording.mp3\"]}")
		fmt.Println("    3. Pass a folder: {\"voiceSampleDir\": \"path/to/samples\"}")
		fmt.Println("\n  Tips for best results:")
		fmt.Println("    - Record 1-3 minutes of clear speech")
		fmt.Println("    - Minimize background noise")
		fmt.Println("    - Speak naturally in the tone you want for your ads")
		os.Exit(1)
	}

	voiceName := "AutoCMO Voice"
	if cmd.VoiceName != "" {
		voiceName = cmd.VoiceName
	}

	fmt.Printf("\n  Cloning voice \"%s\" from %d sample(s)...\n", voiceName, len(samples))

	voiceID, err := elevenLabsCloneVoice(cfg, voiceName, samples)
	if err != nil {
		log.Fatalf("[ERROR] Voice cloning failed: %v", err)
	}

	fmt.Printf("\n  Voice cloned successfully!")
	fmt.Printf("\n  Voice ID: %s\n", voiceID)

	// Auto-update the config file with the new voice ID
	if configPath == "" {
		exe, _ := os.Executable()
		configPath = filepath.Join(filepath.Dir(exe), "autocmo-config.json")
	}
	if err := updateConfigVoiceID(configPath, voiceID); err != nil {
		fmt.Printf("\n  [WARN] Could not auto-update config: %v\n", err)
		fmt.Printf("  Manually set elevenLabsVoiceId to: %s\n", voiceID)
	} else {
		fmt.Printf("  Config updated: elevenLabsVoiceId → %s\n", voiceID)
	}

	fmt.Println("\n============================================================")
	fmt.Println("  Your cloned voice is now the default for all ad voiceovers.")
	fmt.Println("============================================================")
}

// updateConfigVoiceID reads the config JSON, updates the voice ID, and writes it back.
func updateConfigVoiceID(configPath string, voiceID string) error {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	raw["elevenLabsVoiceId"] = voiceID

	out, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, out, 0644)
}

func runImagePipeline(cfg *Config, cmd *Command) {
	started := time.Now()
	fmt.Println("============================================================")
	fmt.Printf("AutoCMO Image — %s\n", cfg.ProductName)
	fmt.Println("============================================================")

	if cfg.GoogleAPIKey == "" && cfg.FalAPIKey == "" {
		log.Fatal("[ERROR] Need googleApiKey or falApiKey for image generation")
	}
	// Use resolved provider — respects command override and config
	imgProvider := resolveImageProvider(cfg, cmd)
	useFal := imgProvider == "fal"
	// If fal selected but no key, fall back to gemini
	if useFal && cfg.FalAPIKey == "" {
		useFal = false
	}
	// If gemini selected explicitly via command, use it
	if cmd != nil && cmd.Provider == "gemini" {
		useFal = false
	}

	// Create run folder
	runID := time.Now().Format("20060102_150405")
	runDir := filepath.Join(cfg.OutputDir, "img_"+runID)
	if err := os.MkdirAll(runDir, 0755); err != nil {
		log.Fatalf("[ERROR] Cannot create run dir: %v", err)
	}
	fmt.Printf("  Output folder: %s\n", runDir)

	// Build prompt
	prompt := fmt.Sprintf(
		"Create a high-quality UGC-style product photo of %s. %s. "+
			"The image should look like an authentic social media post — natural lighting, "+
			"lifestyle setting, someone casually using or wearing the product. "+
			"Make it look real and aspirational, not like a studio ad.",
		cfg.ProductName, cfg.ProductDescription,
	)
	if cmd != nil && cmd.ImagePrompt != "" {
		prompt = cmd.ImagePrompt
	}

	// How many images
	count := 1
	if cmd != nil && cmd.ImageCount > 0 {
		count = cmd.ImageCount
		if count > 4 {
			count = 4
		}
	}

	// Load reference images
	refs := resolveReferences(cfg, cmd)
	if len(refs) > 0 {
		fmt.Printf("  Using %d reference image(s)\n", len(refs))
	}

	// Determine formats — Facebook-compatible: portrait (4:5) + square (1:1)
	imgFormat := "both"
	if cmd != nil && cmd.ImageFormat != "" {
		imgFormat = cmd.ImageFormat
	}
	type formatSpec struct {
		suffix string
		ratio  string
		desc   string
	}
	var formats []formatSpec
	switch imgFormat {
	case "portrait":
		formats = []formatSpec{{"portrait", "4:5", "1080x1350 portrait (Facebook/Instagram feed)"}}
	case "square":
		formats = []formatSpec{{"square", "1:1", "1080x1080 square (Facebook/Instagram universal)"}}
	default: // "both"
		formats = []formatSpec{
			{"portrait", "4:5", "1080x1350 portrait (Facebook/Instagram feed)"},
			{"square", "1:1", "1080x1080 square (Facebook/Instagram universal)"},
		}
	}

	totalImages := count * len(formats)
	provider := "Gemini"
	if useFal {
		provider = "Flux Pro (fal.ai)"
	}
	fmt.Printf("\n[1/2] Generating %d image(s) in %d format(s) via %s...\n", count, len(formats), provider)

	var imagePaths []string
	for i := 0; i < count; i++ {
		for _, f := range formats {
			imgPath := filepath.Join(runDir, fmt.Sprintf("image_%d_%s.jpg", i+1, f.suffix))

			if useFal {
				imgModel := ""
				if cmd != nil {
					imgModel = cmd.ImageModel
				}
				// Image-to-image edit models (banana-edit, banana-pro-edit)
				isEditModel := strings.HasSuffix(imgModel, "-edit")
				if isEditModel && len(refs) > 0 {
					var refURLs []string
					for _, r := range refs {
						url, err := falUploadFile(cfg, r.Path)
						if err != nil {
							fmt.Printf("  [WARN] Failed to upload ref %s: %v\n", r.Path, err)
							continue
						}
						refURLs = append(refURLs, url)
					}
					if len(refURLs) > 0 {
						if err := falGenerateImageEdit(cfg, prompt, imgPath, f.suffix, refURLs); err != nil {
							log.Printf("  [WARN] Image %d (%s) failed: %v", i+1, f.suffix, err)
							continue
						}
					} else {
						baseModel := strings.TrimSuffix(imgModel, "-edit")
						log.Printf("  [WARN] No refs uploaded, falling back to %s text-to-image", baseModel)
						if err := falGenerateImage(cfg, prompt, imgPath, f.suffix, baseModel); err != nil {
							log.Printf("  [WARN] Image %d (%s) failed: %v", i+1, f.suffix, err)
							continue
						}
					}
				} else if isEditModel && len(refs) == 0 {
					// Edit model but no refs — fall back to text-to-image variant
					baseModel := strings.TrimSuffix(imgModel, "-edit")
					fmt.Printf("  No reference images — using %s text-to-image\n", baseModel)
					if err := falGenerateImage(cfg, prompt, imgPath, f.suffix, baseModel); err != nil {
						log.Printf("  [WARN] Image %d (%s) failed: %v", i+1, f.suffix, err)
						continue
					}
				} else if err := falGenerateImage(cfg, prompt, imgPath, f.suffix, imgModel); err != nil {
					log.Printf("  [WARN] Image %d (%s) failed: %v", i+1, f.suffix, err)
					continue
				}
				imagePaths = append(imagePaths, imgPath)
				fmt.Printf("  ✓ %s\n", f.desc)
			} else {
				// Gemini fallback
				formatPrompt := fmt.Sprintf("%s\n\nIMPORTANT: Generate this image in %s aspect ratio (%s).", prompt, f.ratio, f.desc)
				if err := geminiGenerateImage(cfg, formatPrompt, imgPath, refs); err != nil {
					log.Printf("  [WARN] Image %d (%s) failed: %v", i+1, f.suffix, err)
					continue
				}
				matches, _ := filepath.Glob(filepath.Join(runDir, fmt.Sprintf("image_%d_%s.*", i+1, f.suffix)))
				if len(matches) > 0 {
					imagePaths = append(imagePaths, matches[0])
					fmt.Printf("  ✓ %s\n", f.desc)
				}
			}
		}
	}
	_ = totalImages

	if len(imagePaths) == 0 {
		log.Fatal("[ERROR] No images were generated")
	}

	// Save prompt for reference
	os.WriteFile(filepath.Join(runDir, "prompt.txt"), []byte(prompt), 0644)

	// Post to Slack
	skipPost := cmd != nil && cmd.SkipSlack
	if !skipPost && cfg.SlackWebhookURL == "" {
		skipPost = true
		fmt.Println("\n[2/2] Skipping Slack (not configured)")
	}
	if !skipPost {
		fmt.Println("\n[2/2] Posting to Slack...")
		for _, imgPath := range imagePaths {
			title := fmt.Sprintf("Ad Image — %s", cfg.ProductName)
			if _, err := slackUploadFile(cfg, imgPath, title); err != nil {
				fmt.Printf("  [WARN] Upload failed for %s: %v\n", filepath.Base(imgPath), err)
			}
		}

		// Post summary message via webhook
		meta := &VideoMeta{
			Script:      prompt,
			VideoFormat: "image",
			Duration:    0,
		}
		customMsg := ""
		if cmd != nil {
			customMsg = cmd.SlackMessage
		}
		if err := slackPost(cfg, "", "", meta, customMsg); err != nil {
			fmt.Printf("  [WARN] Slack message failed: %v\n", err)
		}
		fmt.Println("  Posted successfully!")
	} else {
		fmt.Println("\n[2/2] Skipping Slack (disabled by command)")
	}

	fmt.Println("\n============================================================")
	fmt.Printf("Image pipeline complete in %s\n", time.Since(started).Round(time.Second))
	fmt.Printf("  Folder: %s\n", runDir)
	for _, p := range imagePaths {
		fmt.Printf("  Image:  %s\n", p)
	}
	fmt.Println("============================================================")
}

func downloadFile(url, dest string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, url)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	n, err := io.Copy(f, resp.Body)
	if err != nil {
		return err
	}
	fmt.Printf("  Downloaded: %.0f KB\n", float64(n)/1024)
	return nil
}

// downloadFileWithKey downloads a file using a Google API key for authentication.
// Veo video URIs require the key either as a query param or x-goog-api-key header.
func downloadFileWithKey(url, dest, apiKey string) error {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("x-goog-api-key", apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("video download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d downloading video: %s", resp.StatusCode, string(body))
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	n, err := io.Copy(f, resp.Body)
	if err != nil {
		return err
	}
	fmt.Printf("  Downloaded: video.mp4 (%.0f KB)\n", float64(n)/1024)
	return nil
}

// runBatchPipeline generates multiple variations in parallel.
// Each variation gets a unique run folder. Results are summarized at the end.
func runBatchPipeline(cfg *Config, cmd *Command) {
	count := cmd.BatchCount
	if count <= 0 {
		count = 3
	}
	if count > 5 {
		count = 5
	}

	fmt.Println("============================================================")
	fmt.Printf("Batch Pipeline — %d variations for %s\n", count, cfg.ProductName)
	fmt.Println("============================================================")

	started := time.Now()
	type batchResult struct {
		Index   int
		RunDir  string
		Success bool
		Err     string
	}

	results := make([]batchResult, count)
	var wg sync.WaitGroup

	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()

			// Create a per-variation command with a unique suffix
			varCmd := *cmd
			varCmd.Action = "generate"
			varCmd.BatchCount = 0 // prevent recursion
			varCmd.SkipSlack = true // never post batch items individually

			// Run the pipeline — capture panics
			func() {
				defer func() {
					if r := recover(); r != nil {
						results[idx] = batchResult{Index: idx, Success: false, Err: fmt.Sprintf("panic: %v", r)}
					}
				}()
				runPipelineWithCommand(cfg, &varCmd)
				// Find the most recent run dir
				entries, _ := os.ReadDir(cfg.OutputDir)
				if len(entries) > 0 {
					last := entries[len(entries)-1]
					results[idx] = batchResult{Index: idx, RunDir: filepath.Join(cfg.OutputDir, last.Name()), Success: true}
				} else {
					results[idx] = batchResult{Index: idx, Success: true}
				}
			}()
		}(i)

		// Stagger starts by 2 seconds to avoid API rate limits
		if i < count-1 {
			time.Sleep(2 * time.Second)
		}
	}

	wg.Wait()

	fmt.Println("\n============================================================")
	fmt.Printf("Batch complete — %d variations in %s\n", count, time.Since(started).Round(time.Second))
	fmt.Println("============================================================")
	for _, r := range results {
		if r.Success {
			fmt.Printf("  [%d] ✓ %s\n", r.Index+1, r.RunDir)
		} else {
			fmt.Printf("  [%d] ✗ %s\n", r.Index+1, r.Err)
		}
	}
	fmt.Println("============================================================")
}

// runArchive moves result folders older than `days` to results/archive/.
func runArchive(cfg *Config, days int) {
	fmt.Println("============================================================")
	fmt.Printf("Archiving results older than %d days\n", days)
	fmt.Println("============================================================")

	cutoff := time.Now().AddDate(0, 0, -days)
	archiveDir := filepath.Join(cfg.OutputDir, "archive")
	moved := 0

	entries, err := os.ReadDir(cfg.OutputDir)
	if err != nil {
		log.Fatalf("[ERROR] Cannot read results dir: %v", err)
	}

	for _, e := range entries {
		if !e.IsDir() || e.Name() == "archive" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			if moved == 0 {
				os.MkdirAll(archiveDir, 0755)
			}
			src := filepath.Join(cfg.OutputDir, e.Name())
			dst := filepath.Join(archiveDir, e.Name())
			if err := os.Rename(src, dst); err != nil {
				fmt.Printf("  [WARN] Cannot move %s: %v\n", e.Name(), err)
				continue
			}
			fmt.Printf("  Archived: %s\n", e.Name())
			moved++
		}
	}

	if moved == 0 {
		fmt.Println("  Nothing to archive — all results are recent")
	} else {
		fmt.Printf("  Moved %d folder(s) to results/archive/\n", moved)
	}
}

// runSelfUpdate checks for a new version and replaces the current binary.
func runSelfUpdate() {
	fmt.Printf("AutoCMO Pipeline v%s\n", appVersion)
	fmt.Println("Checking for updates...")

	// Check latest version from GitHub releases
	versionURL := updateURL + "/version.txt"
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(versionURL)
	if err != nil {
		fmt.Printf("  Cannot check for updates: %v\n", err)
		fmt.Println("  Download manually from the GitHub releases page.")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		fmt.Println("  No update server configured yet.")
		fmt.Println("  Current version: v" + appVersion)
		return
	}

	body, _ := io.ReadAll(resp.Body)
	latest := strings.TrimSpace(string(body))

	if latest == appVersion {
		fmt.Println("  Already up to date!")
		return
	}

	fmt.Printf("  New version available: v%s (current: v%s)\n", latest, appVersion)

	// Determine binary name for this OS
	binaryName := "AutoCMO"
	switch runtime.GOOS {
	case "windows":
		binaryName += "-windows-amd64.exe"
	case "darwin":
		if runtime.GOARCH == "arm64" {
			binaryName += "-darwin-arm64"
		} else {
			binaryName += "-darwin-amd64"
		}
	case "linux":
		binaryName += "-linux-amd64"
	}

	downloadURL := updateURL + "/" + binaryName
	fmt.Printf("  Downloading: %s\n", downloadURL)

	resp2, err := client.Get(downloadURL)
	if err != nil {
		fmt.Printf("  Download failed: %v\n", err)
		return
	}
	defer resp2.Body.Close()

	if resp2.StatusCode != 200 {
		fmt.Printf("  Download failed: HTTP %d\n", resp2.StatusCode)
		return
	}

	// Write to temp file
	exePath, _ := os.Executable()
	tmpPath := exePath + ".update"
	f, err := os.Create(tmpPath)
	if err != nil {
		fmt.Printf("  Cannot create temp file: %v\n", err)
		return
	}

	n, err := io.Copy(f, resp2.Body)
	f.Close()
	if err != nil {
		os.Remove(tmpPath)
		fmt.Printf("  Download incomplete: %v\n", err)
		return
	}

	// Make executable
	os.Chmod(tmpPath, 0755)

	// Replace current binary
	backupPath := exePath + ".backup"
	os.Remove(backupPath)
	if err := os.Rename(exePath, backupPath); err != nil {
		os.Remove(tmpPath)
		fmt.Printf("  Cannot backup current binary: %v\n", err)
		return
	}
	if err := os.Rename(tmpPath, exePath); err != nil {
		// Restore backup
		os.Rename(backupPath, exePath)
		fmt.Printf("  Cannot replace binary: %v\n", err)
		return
	}
	os.Remove(backupPath)

	// On macOS, remove quarantine attribute and ad-hoc codesign
	if runtime.GOOS == "darwin" {
		exec.Command("xattr", "-d", "com.apple.quarantine", exePath).Run()
		exec.Command("codesign", "--force", "--sign", "-", exePath).Run()
	}

	fmt.Printf("  Updated to v%s (%.0f KB)\n", latest, float64(n)/1024)
	fmt.Println("  Restart the pipeline to use the new version.")
}

// clearMacQuarantine removes the macOS quarantine attribute from the binary.
// Called automatically during install on macOS.
func clearMacQuarantine(binaryPath string) {
	if runtime.GOOS != "darwin" {
		return
	}
	// Remove quarantine flag so Gatekeeper doesn't block it
	cmd := exec.Command("xattr", "-d", "com.apple.quarantine", binaryPath)
	cmd.Run()
	// Also ad-hoc codesign so macOS trusts it
	cmd2 := exec.Command("codesign", "--force", "--sign", "-", binaryPath)
	if out, err := cmd2.CombinedOutput(); err != nil {
		fmt.Printf("  [NOTE] Ad-hoc signing: %v (%s)\n", err, strings.TrimSpace(string(out)))
	} else {
		fmt.Println("  Signed binary (ad-hoc) for macOS Gatekeeper")
	}
}

// installProject creates a ready-to-use AutoCMO project folder.
// The user opens this folder in Claude Desktop/Code — /cmo works immediately.
func installProject(targetDir string) error {
	fmt.Println("============================================================")
	fmt.Println("  AutoCMO — Installing...")
	fmt.Println("============================================================")

	// Resolve to absolute path
	abs, err := filepath.Abs(targetDir)
	if err != nil {
		return err
	}
	targetDir = abs

	// Create directory structure
	dirs := []string{
		filepath.Join(targetDir, ".claude", "commands"),
		filepath.Join(targetDir, ".claude", "tools"),
		filepath.Join(targetDir, "assets", "music"),
		filepath.Join(targetDir, "assets", "brands"),
		filepath.Join(targetDir, "results"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return fmt.Errorf("cannot create %s: %w", d, err)
		}
	}

	// Copy this exe into .claude/tools/
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot find own exe path: %w", err)
	}
	destExe := filepath.Join(targetDir, ".claude", "tools", "AutoCMO.exe")
	if err := copyFile(exePath, destExe); err != nil {
		return fmt.Errorf("cannot copy exe: %w", err)
	}
	fmt.Printf("  Copied: .claude/tools/AutoCMO.exe\n")

	// On macOS, clear quarantine and ad-hoc sign so Gatekeeper allows it
	clearMacQuarantine(destExe)

	// Write config template
	configPath := filepath.Join(targetDir, ".claude", "tools", "autocmo-config.json")
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		if err := os.WriteFile(configPath, []byte(configTemplate), 0644); err != nil {
			return err
		}
		fmt.Printf("  Created: .claude/tools/autocmo-config.json\n")
	} else {
		fmt.Printf("  Skipped: autocmo-config.json (already exists)\n")
	}

	// Write skill file (skip if exists to preserve customizations)
	skillPath := filepath.Join(targetDir, ".claude", "commands", "cmo.md")
	if _, err := os.Stat(skillPath); os.IsNotExist(err) {
		if err := os.WriteFile(skillPath, []byte(skillTemplate), 0644); err != nil {
			return err
		}
		fmt.Printf("  Created: .claude/commands/cmo.md\n")
	} else {
		fmt.Printf("  Skipped: cmo.md (already exists)\n")
	}

	// Write CLAUDE.md
	claudeMdPath := filepath.Join(targetDir, "CLAUDE.md")
	if _, err := os.Stat(claudeMdPath); os.IsNotExist(err) {
		if err := os.WriteFile(claudeMdPath, []byte(claudeMdTemplate), 0644); err != nil {
			return err
		}
		fmt.Printf("  Created: CLAUDE.md\n")
	}

	// Write memory.md
	memoryPath := filepath.Join(targetDir, "memory.md")
	if _, err := os.Stat(memoryPath); os.IsNotExist(err) {
		if err := os.WriteFile(memoryPath, []byte("# AutoCMO Memory\n\n## Run Log\n\n## What Works\n\n## What Fails\n\n## Model Notes\n"), 0644); err != nil {
			return err
		}
		fmt.Printf("  Created: memory.md\n")
	}

	// Write settings.json
	settingsPath := filepath.Join(targetDir, ".claude", "settings.json")
	if _, err := os.Stat(settingsPath); os.IsNotExist(err) {
		if err := os.WriteFile(settingsPath, []byte(settingsTemplate), 0644); err != nil {
			return err
		}
		fmt.Printf("  Created: .claude/settings.json\n")
	}

	// Write project README (skip if exists to preserve customizations)
	readmePath := filepath.Join(targetDir, "README.txt")
	if _, err := os.Stat(readmePath); os.IsNotExist(err) {
		if err := os.WriteFile(readmePath, []byte(projectReadmeText), 0644); err != nil {
			return err
		}
		fmt.Printf("  Created: README.txt\n")
	} else {
		fmt.Printf("  Skipped: README.txt (already exists)\n")
	}

	fmt.Println("\n============================================================")
	fmt.Println("  DONE! Next steps:")
	fmt.Println("============================================================")
	fmt.Printf("  1. Open %s in Claude Code\n", targetDir)
	fmt.Println("  2. Type: /cmo")
	fmt.Println("  3. Setup flow walks you through API keys + brand import")
	fmt.Println("============================================================")

	return nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0755)
}

const configTemplate = `{
  "falApiKey": "",
  "googleApiKey": "",
  "elevenLabsApiKey": "",
  "heygenApiKey": "",
  "arcadsApiKey": "",

  "falModel": "veo",
  "imageModel": "banana-pro-edit",

  "slackWebhookUrl": "",
  "slackBotToken": "",
  "slackChannel": "",

  "metaAccessToken": "",
  "metaAdAccountId": "",
  "metaPageId": "",
  "metaPixelId": "",

  "tiktokAccessToken": "",
  "tiktokAdvertiserId": "",
  "tiktokPixelId": "",

  "shopifyStore": "",
  "shopifyAccessToken": "",

  "productName": "My Product",
  "productUrl": "https://myproduct.com",
  "productDescription": "A short description of your product.",
  "outputDir": "../../results",
  "qualityGate": true
}
`

const skillTemplate = `---
name: cmo
description: AI content engine — generate ads, manage campaigns, write SEO blogs, all via natural language.
user-invocable: true
---

You are an AI content engine. The user speaks plain English. You handle everything.

## Step 0: Resolve Brand + Product

### Meta Ads — Autonomous Ad Management

When Meta is configured, the full loop is:

` + "```" + `
Daily 9 AM: auto-cmo generates content
  → Generate 3 variations (batch mode)
  → Visual QA passes all 3
  → Push all 3 into ONE ad set in "Auto CMO - Testing" ($5/day)

Daily 10 AM: auto-cmo-optimize reviews yesterday
  → KILL: CTR < 0.5% after $5 spend
  → WINNER: Cost per ATC < $10 after $3 spend → copy to Scaling
  → MASSIVE WINNER: 3.0+ ROAS after $1000+ spend → create 1% lookalike

Monday 9 AM: auto-cmo-digest — weekly summary
` + "```" + `

**Two campaigns auto-created:**
- **Auto CMO - Testing** (ABO) — $5/day per ad. Isolated testing.
- **Auto CMO - Scaling** (CBO) — winners moved here. Meta optimizes budget.

## Folder Structure
` + "```" + `
assets/
├── music/                          ← Background tracks (shared)
└── brands/
    └── <brand>/                    ← e.g., "madchill"
        ├── brand.md                ← Brand voice, audience, CTA style
        ├── quality-benchmark/      ← S-tier ad examples
        ├── voices/                 ← Voice samples
        ├── avatars/                ← Creator faces/videos
        └── products/
            └── <product>/          ← e.g., "full-zip"
                ├── references/     ← Product photos
                └── product.md      ← Product details
` + "```" + `

### Detection Logic
1. **List brands**: scan ` + "`" + `assets/brands/` + "`" + ` for subdirs with ` + "`" + `brand.md` + "`" + `
2. **List products**: scan ` + "`" + `assets/brands/<brand>/products/` + "`" + ` for subdirs with ` + "`" + `references/` + "`" + `
3. **Route from input**: ` + "`" + `/cmo cream-set video` + "`" + ` → find which brand contains it
4. **If no brand exists** → trigger Setup Flow

## Step 1: Load Context

Before every run:
1. Read brand.md + product.md (generate if missing)
2. Read memory.md
3. Read reference images + quality benchmarks

## Step 2: Smart Routing

| User wants... | Mode | Pipeline | Est. cost |
|---|---|---|---|
| Product footage, lifestyle, B-roll | ` + "`" + `product-showcase` + "`" + ` | Veo via fal.ai | ~$1.20/6s |
| Product photos, ad images | ` + "`" + `image` + "`" + ` | Flux Pro via fal.ai | ~$0.04/img |
| Someone talking to camera | ` + "`" + `talking-head` + "`" + ` | HeyGen | ~$1/min |

## Step 3: Write the Script

- **talking-head**: 40-50 words. EXACT dialogue.
- **product-showcase**: 30-40 words. Voiceover narration.

Rules: Hook in 3 seconds. Sound human. ONE specific detail from photos. CTA from brand.md.

## Step 4: Cost Estimate + Confirmation

Show estimate, get confirmation. **Scheduled tasks skip confirmation.**

## Step 5: Run the Pipeline

` + "```" + `
.claude/tools/AutoCMO.exe --config .claude/tools/autocmo-config.json --cmd '<JSON>'
` + "```" + `

Always pass ` + "`" + `"skipSlack": true` + "`" + ` unless user says to post.

### Command JSON
` + "```" + `json
{
  "action": "generate",
  "mode": "product-showcase",
  "script": "...",
  "productHook": "...",
  "duration": 5,
  "voiceStyle": "natural",
  "referencesDir": "assets/brands/<brand>/products/<product>/references",
  "skipSlack": true
}
` + "```" + `

### Batch Mode
"Make 3 variations":
` + "```" + `json
{"action": "batch", "batchCount": 3, "mode": "product-showcase", "script": "...", "skipSlack": true}
` + "```" + `

### Archive Old Results
` + "```" + `json
{"action": "archive", "archiveDays": 30}
` + "```" + `

### Utility Commands
| Action | JSON |
|--------|------|
| Clone voice | ` + "`" + `{"action": "clone-voice", "voiceSampleDir": "assets/brands/<brand>/voices", "voiceName": "Brand Voice"}` + "`" + ` |
| List voices | ` + "`" + `{"action": "list-voices"}` + "`" + ` |
| List avatars | ` + "`" + `{"action": "list-avatars"}` + "`" + ` |
| Dry run | ` + "`" + `{"action": "dry-run"}` + "`" + ` |
| Push to Meta | ` + "`" + `{"action": "meta-push", "adImagePath": "...", "adHeadline": "...", "adBody": "...", "dailyBudget": 5}` + "`" + ` |
| Meta perf | ` + "`" + `{"action": "meta-insights"}` + "`" + ` |
| Kill ad | ` + "`" + `{"action": "meta-kill", "adId": "AD_ID"}` + "`" + ` |
| Scale winner | ` + "`" + `{"action": "meta-duplicate", "adId": "AD_ID", "campaignId": "SCALING_ID"}` + "`" + ` |
| Setup Meta | ` + "`" + `{"action": "meta-setup"}` + "`" + ` |
| Lookalike | ` + "`" + `{"action": "meta-lookalike", "adId": "WINNER_AD_ID"}` + "`" + ` |

## Step 6: Visual QA + Inline Preview

After pipeline finishes, read output and score against references + benchmarks.
Show quality report. If fails → regenerate (max 3 attempts). Show passing output inline.

## Step 7: Update Memory

After every run, update memory.md: run log, what works, what fails, model notes.

## Setup Flow (first-run only)

1. Ask for fal.ai API key (only required key)
2. Ask for brand name + website → scrape → write brand.md
3. Try Shopify /products.json → auto-import product images
4. Offer to set up daily auto-generation (scheduled task)
5. Optional: Meta Ads setup (access token, ad account, page, pixel)
`

const projectReadmeText = `AutoCMO -- AI Content Engine
============================

1. Open this folder in Claude Code
2. Type: /cmo

First run walks you through API key setup (only fal.ai key needed)
and auto-builds your brand profile from your website.

Then just talk naturally:

  /cmo cream-set product video
  /cmo pink-set make 3 image variations
  /cmo clone my voice
  /cmo check Meta performance

Adding products:
  Create a folder under assets/brands/<brand>/products/ with a references/ subfolder.
  Drop product photos in it. Claude handles the rest.

Batch mode:
  /cmo make 3 variations of cream-set

Meta Ads:
  /cmo push to Meta
  /cmo check Meta performance

Maintenance:
  /cmo archive old results
`

const claudeMdTemplate = `# AutoCMO -- Portable AI Content Engine

Open in Claude Code. Type /cmo.

## Session Protocol

### On Start
1. Scan assets/brands/ for brands and products
2. Read active brand brand.md + product product.md
3. Read memory.md

### On Every Run
1. Resolve brand + product from request
2. Load brand.md + product.md + reference photos + quality benchmarks
3. After pipeline: show output inline, get approval before posting
4. After approval: update memory.md

## Key Rules
- Only falApiKey required to start. Everything else optional.
- Show cost estimate before running. Get confirmation.
- Show output inline before posting anywhere. skipSlack: true by default.
- Scheduled/automated runs skip confirmation.
- Memory compounds: every run improves the next.
- Music from assets/music/ is auto-mixed into videos at -18dB.
`

const settingsTemplate = `{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "echo Session complete"
      }
    ]
  }
}
`

func printSetup() {
	fmt.Println(`
============================================================
  AutoCMO — Setup Guide
============================================================

  1. Open autocmo-config.json (next to this .exe)

  2. Fill in API keys for the providers you want:

     VIDEO (pick at least one):
     ─────────────────────────
     googleApiKey    → https://aistudio.google.com/apikey
                       Powers both Veo (video) and Gemini (image). Free tier.

     arcadsApiKey    → https://app.arcads.ai → Settings → API Keys
                       AI avatar-based ad videos.

     heygenApiKey    → https://app.heygen.com/settings → API
                       Talking-head ad videos.

     IMAGE:
     ─────
     (Uses googleApiKey — same key as Veo)

     VOICE:
     ──────
     elevenLabsApiKey → https://elevenlabs.io → Profile → API Key
                        Free tier: clone your own voice.

     SLACK:
     ──────
     slackWebhookUrl  → https://api.slack.com/apps → Incoming Webhooks
     slackBotToken    → Same app → OAuth & Permissions → Bot Token (xoxb-...)
                        Needs: files:write, chat:write scopes
     slackChannel     → Right-click channel → View details → Channel ID

  3. (Optional) Set videoProvider/imageProvider/voiceProvider
     in the config, or leave as "auto" to pick from your keys.

  4. (Optional) Drop product photos in references/

  5. Test: AutoCMO.exe --dry-run

  6. Run:  AutoCMO.exe

============================================================`)
}

func testScript(cfg *Config) string {
	return fmt.Sprintf(
		"Hey, have you heard about %s? %s Check it out at %s — you won't regret it!",
		cfg.ProductName, cfg.ProductDescription, cfg.ProductURL,
	)
}

func createPlaceholderVideo(path string) error {
	// Generates a minimal valid MP4 (ftyp + moov + mdat) that Discord will render
	// as an inline video player. 1-second black frame, 320x240, H.264 baseline.
	// Built from raw ISO BMFF boxes — no ffmpeg or external tools needed.
	mp4 := buildMinimalMP4()
	return os.WriteFile(path, mp4, 0644)
}

// --- Minimal MP4 generator (ISO BMFF / H.264 baseline) ---

func buildMinimalMP4() []byte {
	// Single black IDR frame, 320x240, H.264 baseline profile
	sps := []byte{0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x07, 0x3c, 0x04, 0x40, 0x00, 0x00, 0x03, 0x00, 0x40, 0x00, 0x00, 0x0f, 0x03, 0xc5, 0x8b, 0xa8}
	pps := []byte{0x68, 0xce, 0x38, 0x80}
	// Minimal IDR slice (all-zero macroblocks = black frame)
	idr := []byte{0x65, 0x88, 0x80, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6d, 0xb6, 0xdb, 0x6d, 0xb4}

	// Build the access unit (length-prefixed NALUs)
	var sample []byte
	sample = append(sample, u32be(uint32(len(sps)))...)
	sample = append(sample, sps...)
	sample = append(sample, u32be(uint32(len(pps)))...)
	sample = append(sample, pps...)
	sample = append(sample, u32be(uint32(len(idr)))...)
	sample = append(sample, idr...)

	sampleSize := uint32(len(sample))

	// Build boxes
	var buf []byte
	buf = append(buf, box("ftyp", concat(
		[]byte("isom"),    // major brand
		u32be(0x200),      // minor version
		[]byte("isomiso2avc1mp41"),
	))...)

	mdatContent := sample
	mdatBox := box("mdat", mdatContent)

	// mdat offset = len(ftyp) + len(moov) — we'll patch after building moov
	ftypLen := uint32(len(buf))

	// Build moov
	moov := buildMoov(sampleSize, 0, sps, pps) // chunk offset placeholder
	moovLen := uint32(len(moov))

	// Patch stco chunk offset: ftyp + moov + mdat header (8 bytes)
	chunkOffset := ftypLen + moovLen + 8
	moov = patchStco(moov, chunkOffset)

	buf = append(buf, moov...)
	buf = append(buf, mdatBox...)
	return buf
}

func buildMoov(sampleSize, chunkOffset uint32, sps, pps []byte) []byte {
	timescale := uint32(24)
	duration := uint32(1) // 1 tick = 1/24 second

	mvhd := fullbox("mvhd", 0, 0, concat(
		u32be(0),         // creation time
		u32be(0),         // modification time
		u32be(timescale), // timescale
		u32be(duration),  // duration
		u32be(0x00010000), // rate 1.0
		u16be(0x0100),     // volume 1.0
		make([]byte, 10),  // reserved
		// identity matrix (9 x u32)
		u32be(0x00010000), u32be(0), u32be(0),
		u32be(0), u32be(0x00010000), u32be(0),
		u32be(0), u32be(0), u32be(0x40000000),
		make([]byte, 24), // pre_defined
		u32be(2),         // next_track_ID
	))

	// avcC
	avcC := box("avcC", concat(
		[]byte{1, sps[1], sps[2], sps[3], 0xff}, // configVersion, profile, compat, level, lengthSize-1
		[]byte{0xe1},                              // numSPS
		u16be(uint16(len(sps))),
		sps,
		[]byte{1}, // numPPS
		u16be(uint16(len(pps))),
		pps,
	))

	// stsd > avc1
	avc1 := box("avc1", concat(
		make([]byte, 6),  // reserved
		u16be(1),         // data ref index
		make([]byte, 16), // pre_defined + reserved
		u16be(320),       // width
		u16be(240),       // height
		u32be(0x00480000), // horiz resolution 72 dpi
		u32be(0x00480000), // vert resolution 72 dpi
		u32be(0),          // reserved
		u16be(1),          // frame count
		make([]byte, 32),  // compressor name
		u16be(0x0018),     // depth
		[]byte{0xff, 0xff}, // pre_defined
		avcC,
	))
	stsd := fullbox("stsd", 0, 0, concat(u32be(1), avc1))

	stts := fullbox("stts", 0, 0, concat(u32be(1), u32be(1), u32be(1))) // 1 sample, delta 1
	stsc := fullbox("stsc", 0, 0, concat(u32be(1), u32be(1), u32be(1), u32be(1))) // first=1, spc=1, sdi=1
	stsz := fullbox("stsz", 0, 0, concat(u32be(0), u32be(1), u32be(sampleSize)))
	stco := fullbox("stco", 0, 0, concat(u32be(1), u32be(chunkOffset)))
	stss := fullbox("stss", 0, 0, concat(u32be(1), u32be(1))) // sample 1 is sync

	stbl := box("stbl", concat(stsd, stts, stsc, stsz, stco, stss))

	dinfRef := box("url ", concat([]byte{0, 0, 0, 1})) // self-contained flag
	dref := fullbox("dref", 0, 0, concat(u32be(1), dinfRef))
	dinf := box("dinf", dref)

	vmhd := fullbox("vmhd", 0, 1, make([]byte, 8))
	minf := box("minf", concat(vmhd, dinf, stbl))

	hdlr := fullbox("hdlr", 0, 0, concat(
		u32be(0),
		[]byte("vide"),
		make([]byte, 12),
		[]byte("VideoHandler\x00"),
	))

	mdhd := fullbox("mdhd", 0, 0, concat(
		u32be(0), u32be(0), u32be(timescale), u32be(duration),
		u16be(0x55C4), // language 'und'
		u16be(0),
	))
	mdia := box("mdia", concat(mdhd, hdlr, minf))

	tkhd := fullbox("tkhd", 0, 3, concat(
		u32be(0), u32be(0), // creation, modification
		u32be(1),           // track ID
		u32be(0),           // reserved
		u32be(duration),    // duration
		make([]byte, 8),    // reserved
		u16be(0),           // layer
		u16be(0),           // alternate group
		u16be(0),           // volume (0 for video)
		u16be(0),           // reserved
		// identity matrix
		u32be(0x00010000), u32be(0), u32be(0),
		u32be(0), u32be(0x00010000), u32be(0),
		u32be(0), u32be(0), u32be(0x40000000),
		u32be(320<<16), // width 320.0
		u32be(240<<16), // height 240.0
	))
	trak := box("trak", concat(tkhd, mdia))

	return box("moov", concat(mvhd, trak))
}

func patchStco(moov []byte, offset uint32) []byte {
	// Find "stco" in moov and patch the chunk offset value (last 4 bytes of the box)
	tag := []byte("stco")
	for i := 0; i < len(moov)-4; i++ {
		if moov[i] == tag[0] && moov[i+1] == tag[1] && moov[i+2] == tag[2] && moov[i+3] == tag[3] {
			// Box: [size(4)][type(4)][version+flags(4)][count(4)][offset(4)]
			// offset is at i + 4 + 4 + 4 = i + 12
			pos := i + 12
			moov[pos] = byte(offset >> 24)
			moov[pos+1] = byte(offset >> 16)
			moov[pos+2] = byte(offset >> 8)
			moov[pos+3] = byte(offset)
			break
		}
	}
	return moov
}

func box(boxType string, payload []byte) []byte {
	size := uint32(8 + len(payload))
	b := u32be(size)
	b = append(b, []byte(boxType)...)
	b = append(b, payload...)
	return b
}

func fullbox(boxType string, version byte, flags uint32, payload []byte) []byte {
	vf := []byte{version, byte(flags >> 16), byte(flags >> 8), byte(flags)}
	return box(boxType, append(vf, payload...))
}

func u32be(v uint32) []byte {
	return []byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
}

func u16be(v uint16) []byte {
	return []byte{byte(v >> 8), byte(v)}
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
