package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

const klaviyoAPIBase = "https://a.klaviyo.com/api/"

// klaviyoRequest makes an authenticated request to the Klaviyo API.
func klaviyoRequest(apiKey, method, endpoint string, body interface{}) ([]byte, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(data)
	}

	url := klaviyoAPIBase + endpoint
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Klaviyo-API-Key "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("revision", "2024-10-15")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("Klaviyo API HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	return respBody, nil
}

// klaviyoGetMetrics lists all tracked metrics (opens, clicks, placed_order, etc.).
func klaviyoGetMetrics(cfg *Config) error {
	data, err := klaviyoRequest(cfg.KlaviyoAPIKey, "GET", "metrics/", nil)
	if err != nil {
		return err
	}

	var result struct {
		Data []struct {
			ID         string `json:"id"`
			Attributes struct {
				Name        string `json:"name"`
				Integration struct {
					Name string `json:"name"`
				} `json:"integration"`
				Created time.Time `json:"created"`
				Updated time.Time `json:"updated"`
			} `json:"attributes"`
		} `json:"data"`
	}
	json.Unmarshal(data, &result)

	fmt.Println("============================================================")
	fmt.Println("  Klaviyo — Tracked Metrics")
	fmt.Println("============================================================")

	if len(result.Data) == 0 {
		fmt.Println("  No metrics found.")
		return nil
	}

	fmt.Printf("\n  %-36s %-30s %s\n", "ID", "METRIC", "INTEGRATION")
	fmt.Println("  ────────────────────────────────────────────────────────────────────────────")
	for _, m := range result.Data {
		name := m.Attributes.Name
		if len(name) > 28 {
			name = name[:28] + ".."
		}
		integration := m.Attributes.Integration.Name
		if integration == "" {
			integration = "-"
		}
		fmt.Printf("  %-36s %-30s %s\n", m.ID, name, integration)
	}

	return nil
}

// klaviyoGetFlows lists all automated flows.
func klaviyoGetFlows(cfg *Config) error {
	data, err := klaviyoRequest(cfg.KlaviyoAPIKey, "GET", "flows/", nil)
	if err != nil {
		return err
	}

	var result struct {
		Data []struct {
			ID         string `json:"id"`
			Attributes struct {
				Name      string `json:"name"`
				Status    string `json:"status"`
				Trigger   string `json:"trigger_type"`
				Created   string `json:"created"`
				Archived  bool   `json:"archived"`
			} `json:"attributes"`
		} `json:"data"`
	}
	json.Unmarshal(data, &result)

	fmt.Println("============================================================")
	fmt.Println("  Klaviyo — Automated Flows")
	fmt.Println("============================================================")

	if len(result.Data) == 0 {
		fmt.Println("  No flows found.")
		return nil
	}

	fmt.Printf("\n  %-36s %-30s %-12s %s\n", "ID", "NAME", "STATUS", "TRIGGER")
	fmt.Println("  ────────────────────────────────────────────────────────────────────────────")
	for _, f := range result.Data {
		if f.Attributes.Archived {
			continue
		}
		name := f.Attributes.Name
		if len(name) > 28 {
			name = name[:28] + ".."
		}
		trigger := f.Attributes.Trigger
		if trigger == "" {
			trigger = "-"
		}
		fmt.Printf("  %-36s %-30s %-12s %s\n", f.ID, name, f.Attributes.Status, trigger)
	}

	return nil
}

// klaviyoGetCampaigns lists recent email campaigns.
func klaviyoGetCampaigns(cfg *Config, days int) error {
	endpoint := "campaigns/?filter=equals(messages.channel,'email')&sort=-scheduled_at"
	data, err := klaviyoRequest(cfg.KlaviyoAPIKey, "GET", endpoint, nil)
	if err != nil {
		return err
	}

	var result struct {
		Data []struct {
			ID         string `json:"id"`
			Attributes struct {
				Name        string `json:"name"`
				Status      string `json:"status"`
				ScheduledAt string `json:"scheduled_at"`
				SendTime    string `json:"send_time"`
				CreatedAt   string `json:"created_at"`
			} `json:"attributes"`
		} `json:"data"`
	}
	json.Unmarshal(data, &result)

	fmt.Println("============================================================")
	fmt.Println("  Klaviyo — Email Campaigns")
	fmt.Println("============================================================")

	if len(result.Data) == 0 {
		fmt.Println("  No campaigns found.")
		return nil
	}

	fmt.Printf("\n  %-36s %-35s %-12s %s\n", "ID", "NAME", "STATUS", "SCHEDULED")
	fmt.Println("  ────────────────────────────────────────────────────────────────────────────")
	for _, c := range result.Data {
		name := c.Attributes.Name
		if len(name) > 33 {
			name = name[:33] + ".."
		}
		scheduled := c.Attributes.ScheduledAt
		if scheduled == "" {
			scheduled = c.Attributes.SendTime
		}
		if len(scheduled) > 10 {
			scheduled = scheduled[:10]
		}
		if scheduled == "" {
			scheduled = "-"
		}
		fmt.Printf("  %-36s %-35s %-12s %s\n", c.ID, name, c.Attributes.Status, scheduled)
	}

	return nil
}

// klaviyoGetPerformance builds a performance summary: metrics + campaigns overview.
func klaviyoGetPerformance(cfg *Config, days int) {
	if cfg.KlaviyoAPIKey == "" {
		log.Fatal("[ERROR] klaviyoApiKey required — get it from Klaviyo → Settings → API Keys")
	}

	fmt.Println("============================================================")
	fmt.Println("  Klaviyo — Email Performance Summary")
	fmt.Println("============================================================")

	// List metrics
	if err := klaviyoGetMetrics(cfg); err != nil {
		fmt.Printf("  [WARN] Could not fetch metrics: %v\n", err)
	}

	// List flows
	if err := klaviyoGetFlows(cfg); err != nil {
		fmt.Printf("  [WARN] Could not fetch flows: %v\n", err)
	}

	// List recent campaigns
	if err := klaviyoGetCampaigns(cfg, days); err != nil {
		fmt.Printf("  [WARN] Could not fetch campaigns: %v\n", err)
	}

	fmt.Println("\n============================================================")
}

// klaviyoCreateCampaign creates a draft email campaign.
func klaviyoCreateCampaign(cfg *Config, name, subject, listID, templateHTML string) error {
	if cfg.KlaviyoAPIKey == "" {
		return fmt.Errorf("klaviyoApiKey required")
	}

	payload := map[string]interface{}{
		"data": map[string]interface{}{
			"type": "campaign",
			"attributes": map[string]interface{}{
				"name":             name,
				"campaign-type":    "email",
				"audiences": map[string]interface{}{
					"included": []string{listID},
				},
				"send_options": map[string]interface{}{
					"use_smart_sending": true,
				},
				"message": map[string]interface{}{
					"subject": subject,
					"body":    templateHTML,
				},
			},
		},
	}

	data, err := klaviyoRequest(cfg.KlaviyoAPIKey, "POST", "campaigns/", payload)
	if err != nil {
		return err
	}

	var result struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	json.Unmarshal(data, &result)

	fmt.Printf("  Created draft campaign: %s (ID: %s)\n", name, result.Data.ID)
	return nil
}

// klaviyoGetLists returns available subscriber lists.
func klaviyoGetLists(cfg *Config) {
	if cfg.KlaviyoAPIKey == "" {
		log.Fatal("[ERROR] klaviyoApiKey required — get it from Klaviyo → Settings → API Keys")
	}

	data, err := klaviyoRequest(cfg.KlaviyoAPIKey, "GET", "lists/", nil)
	if err != nil {
		log.Fatalf("[ERROR] %v", err)
	}

	var result struct {
		Data []struct {
			ID         string `json:"id"`
			Attributes struct {
				Name      string `json:"name"`
				Created   string `json:"created"`
				Updated   string `json:"updated"`
				OptInType string `json:"opt_in_process"`
			} `json:"attributes"`
		} `json:"data"`
	}
	json.Unmarshal(data, &result)

	fmt.Println("============================================================")
	fmt.Println("  Klaviyo — Subscriber Lists")
	fmt.Println("============================================================")

	if len(result.Data) == 0 {
		fmt.Println("  No lists found.")
		return
	}

	fmt.Printf("\n  %-36s %-35s %s\n", "ID", "NAME", "OPT-IN")
	fmt.Println("  ────────────────────────────────────────────────────────────────────────────")
	for _, l := range result.Data {
		name := l.Attributes.Name
		if len(name) > 33 {
			name = name[:33] + ".."
		}
		optIn := l.Attributes.OptInType
		if optIn == "" {
			optIn = "-"
		}
		fmt.Printf("  %-36s %-35s %s\n", l.ID, name, optIn)
	}
}
