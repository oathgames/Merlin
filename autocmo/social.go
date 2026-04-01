package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// ── Facebook Page Posting ───────────────────────────────────

// fbPostToPage posts to a Facebook Page. If imageURL is provided, posts as a photo.
// Otherwise posts as a text feed update.
func fbPostToPage(cfg *Config, message, imageURL string) error {
	if cfg.MetaAccessToken == "" || cfg.MetaPageID == "" {
		return fmt.Errorf("metaAccessToken and metaPageId required for Facebook posting")
	}

	var endpoint string
	params := map[string]interface{}{
		"access_token": cfg.MetaAccessToken,
	}

	if imageURL != "" {
		// Photo post
		endpoint = fmt.Sprintf("%s/%s/photos", metaAPIBase, cfg.MetaPageID)
		params["url"] = imageURL
		if message != "" {
			params["message"] = message
		}
	} else {
		// Text-only feed post
		endpoint = fmt.Sprintf("%s/%s/feed", metaAPIBase, cfg.MetaPageID)
		params["message"] = message
	}

	body, _ := json.Marshal(params)
	resp, err := http.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return fmt.Errorf("Facebook API HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		ID    string `json:"id"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	json.Unmarshal(respBody, &result)

	if result.Error != nil {
		return fmt.Errorf("Facebook API error: %s", result.Error.Message)
	}

	fmt.Printf("  Facebook post created: %s\n", result.ID)
	return nil
}

// ── Instagram Posting ───────────────────────────────────────

// igGetAccountID resolves the Instagram Business Account ID from the Facebook Page.
func igGetAccountID(cfg *Config) (string, error) {
	if cfg.MetaAccessToken == "" || cfg.MetaPageID == "" {
		return "", fmt.Errorf("metaAccessToken and metaPageId required for Instagram")
	}

	url := fmt.Sprintf("%s/%s?fields=instagram_business_account&access_token=%s",
		metaAPIBase, cfg.MetaPageID, cfg.MetaAccessToken)

	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("Meta API HTTP %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		InstagramBusinessAccount struct {
			ID string `json:"id"`
		} `json:"instagram_business_account"`
	}
	json.Unmarshal(body, &result)

	if result.InstagramBusinessAccount.ID == "" {
		return "", fmt.Errorf("no Instagram Business Account linked to Page %s", cfg.MetaPageID)
	}

	return result.InstagramBusinessAccount.ID, nil
}

// igCreateMediaContainer creates an IG media container (not yet published).
func igCreateMediaContainer(cfg *Config, igAccountID, imageURL, caption string, isCarouselItem bool) (string, error) {
	params := map[string]interface{}{
		"image_url":    imageURL,
		"access_token": cfg.MetaAccessToken,
	}
	if isCarouselItem {
		params["is_carousel_item"] = true
	} else {
		params["caption"] = caption
	}

	body, _ := json.Marshal(params)
	url := fmt.Sprintf("%s/%s/media", metaAPIBase, igAccountID)

	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("IG media container HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		ID string `json:"id"`
	}
	json.Unmarshal(respBody, &result)

	if result.ID == "" {
		return "", fmt.Errorf("no container ID returned: %s", string(respBody))
	}
	return result.ID, nil
}

// igPublishMedia publishes a previously created media container.
func igPublishMedia(cfg *Config, igAccountID, containerID string) (string, error) {
	params := map[string]interface{}{
		"creation_id":  containerID,
		"access_token": cfg.MetaAccessToken,
	}

	body, _ := json.Marshal(params)
	url := fmt.Sprintf("%s/%s/media_publish", metaAPIBase, igAccountID)

	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("IG publish HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		ID string `json:"id"`
	}
	json.Unmarshal(respBody, &result)

	return result.ID, nil
}

// igPostImage posts a single image to Instagram.
// imageURL must be publicly accessible.
func igPostImage(cfg *Config, imageURL, caption string) error {
	igAccountID, err := igGetAccountID(cfg)
	if err != nil {
		return err
	}

	// Step 1: Create media container
	containerID, err := igCreateMediaContainer(cfg, igAccountID, imageURL, caption, false)
	if err != nil {
		return fmt.Errorf("create container: %w", err)
	}
	fmt.Printf("  IG container created: %s\n", containerID)

	// Brief pause for IG to process the container
	time.Sleep(3 * time.Second)

	// Step 2: Publish
	postID, err := igPublishMedia(cfg, igAccountID, containerID)
	if err != nil {
		return fmt.Errorf("publish: %w", err)
	}

	fmt.Printf("  Instagram post published: %s\n", postID)
	return nil
}

// igPostCarousel posts a multi-image carousel to Instagram.
// All imageURLs must be publicly accessible.
func igPostCarousel(cfg *Config, imageURLs []string, caption string) error {
	if len(imageURLs) < 2 {
		return fmt.Errorf("carousel requires at least 2 images, got %d", len(imageURLs))
	}
	if len(imageURLs) > 10 {
		return fmt.Errorf("carousel max 10 images, got %d", len(imageURLs))
	}

	igAccountID, err := igGetAccountID(cfg)
	if err != nil {
		return err
	}

	// Step 1: Create individual media containers
	var containerIDs []string
	for i, imgURL := range imageURLs {
		cID, err := igCreateMediaContainer(cfg, igAccountID, imgURL, "", true)
		if err != nil {
			return fmt.Errorf("carousel item %d: %w", i+1, err)
		}
		containerIDs = append(containerIDs, cID)
		fmt.Printf("  IG carousel item %d/%d: %s\n", i+1, len(imageURLs), cID)
	}

	// Step 2: Create carousel container
	carouselParams := map[string]interface{}{
		"media_type":   "CAROUSEL",
		"caption":      caption,
		"children":     containerIDs,
		"access_token": cfg.MetaAccessToken,
	}

	body, _ := json.Marshal(carouselParams)
	url := fmt.Sprintf("%s/%s/media", metaAPIBase, igAccountID)

	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return fmt.Errorf("IG carousel container HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var carouselResult struct {
		ID string `json:"id"`
	}
	json.Unmarshal(respBody, &carouselResult)

	if carouselResult.ID == "" {
		return fmt.Errorf("no carousel container ID: %s", string(respBody))
	}
	fmt.Printf("  IG carousel container: %s\n", carouselResult.ID)

	// Brief pause for IG to process
	time.Sleep(5 * time.Second)

	// Step 3: Publish carousel
	postID, err := igPublishMedia(cfg, igAccountID, carouselResult.ID)
	if err != nil {
		return fmt.Errorf("publish carousel: %w", err)
	}

	fmt.Printf("  Instagram carousel published: %s\n", postID)
	return nil
}

// ── CLI Entry Point ─────────────────────────────────────────

// runSocialPost is the CLI entry for organic social posting.
// Takes platform (facebook/instagram/both), message/caption, and optional image.
func runSocialPost(cfg *Config, cmd *Command) {
	if cfg.MetaAccessToken == "" {
		log.Fatal("[ERROR] metaAccessToken required for social posting")
	}
	if cfg.MetaPageID == "" {
		log.Fatal("[ERROR] metaPageId required for social posting")
	}

	platform := strings.ToLower(cmd.SocialPlatform)
	if platform == "" {
		platform = "both"
	}

	message := cmd.SocialCaption
	if message == "" {
		log.Fatal("[ERROR] socialCaption required — the post text/caption")
	}

	// If a local image is provided, upload to fal CDN first
	imageURL := cmd.SocialImageURL
	if cmd.SocialImagePath != "" && imageURL == "" {
		if _, err := os.Stat(cmd.SocialImagePath); err != nil {
			log.Fatalf("[ERROR] Image file not found: %s", cmd.SocialImagePath)
		}
		if cfg.FalAPIKey == "" {
			log.Fatal("[ERROR] falApiKey required to upload local images to CDN")
		}
		fmt.Printf("  Uploading image to CDN: %s\n", cmd.SocialImagePath)
		uploadedURL, err := falUploadFile(cfg, cmd.SocialImagePath)
		if err != nil {
			log.Fatalf("[ERROR] Image upload failed: %v", err)
		}
		imageURL = uploadedURL
		fmt.Printf("  CDN URL: %s\n", imageURL)
	}

	fmt.Println("============================================================")
	fmt.Println("  Social Media — Organic Post")
	fmt.Println("============================================================")

	// Facebook
	if platform == "facebook" || platform == "both" {
		fmt.Println("\n  → Facebook")
		if err := fbPostToPage(cfg, message, imageURL); err != nil {
			fmt.Printf("  [ERROR] Facebook: %v\n", err)
		}
	}

	// Instagram
	if platform == "instagram" || platform == "both" {
		fmt.Println("\n  → Instagram")
		if imageURL == "" {
			fmt.Println("  [SKIP] Instagram requires an image — no image provided")
		} else if len(cmd.SocialCarouselURLs) >= 2 {
			// Carousel mode
			allURLs := append([]string{imageURL}, cmd.SocialCarouselURLs...)
			if err := igPostCarousel(cfg, allURLs, message); err != nil {
				fmt.Printf("  [ERROR] Instagram carousel: %v\n", err)
			}
		} else {
			if err := igPostImage(cfg, imageURL, message); err != nil {
				fmt.Printf("  [ERROR] Instagram: %v\n", err)
			}
		}
	}

	fmt.Println("\n============================================================")
}
