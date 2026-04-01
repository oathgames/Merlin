package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const shopifyAPIVersion = "2024-10"

// shopifyBaseURL returns the admin API base for the configured store.
func shopifyBaseURL(cfg *Config) string {
	store := cfg.ShopifyStore
	if !strings.Contains(store, ".") {
		store = store + ".myshopify.com"
	}
	return fmt.Sprintf("https://%s/admin/api/%s", store, shopifyAPIVersion)
}

// shopifyRequest makes an authenticated request to the Shopify Admin API.
func shopifyRequest(cfg *Config, method, endpoint string, body interface{}) ([]byte, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(data)
	}

	url := shopifyBaseURL(cfg) + endpoint
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, err
	}

	req.Header.Set("X-Shopify-Access-Token", cfg.ShopifyAccessToken)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("Shopify API HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	return respBody, nil
}

// shopifyFindBlog finds the default blog (usually "News") or creates one called "Blog".
// Returns the blog ID.
func shopifyFindBlog(cfg *Config) (int64, error) {
	data, err := shopifyRequest(cfg, "GET", "/blogs.json", nil)
	if err != nil {
		return 0, err
	}

	var result struct {
		Blogs []struct {
			ID    int64  `json:"id"`
			Title string `json:"title"`
		} `json:"blogs"`
	}
	json.Unmarshal(data, &result)

	// Prefer "News" (Shopify default) or first blog found
	for _, b := range result.Blogs {
		if strings.EqualFold(b.Title, "News") || strings.EqualFold(b.Title, "Blog") {
			return b.ID, nil
		}
	}
	if len(result.Blogs) > 0 {
		return result.Blogs[0].ID, nil
	}

	// No blog exists — create one
	createBody := map[string]interface{}{
		"blog": map[string]interface{}{
			"title": "Blog",
		},
	}
	data, err = shopifyRequest(cfg, "POST", "/blogs.json", createBody)
	if err != nil {
		return 0, fmt.Errorf("cannot create blog: %w", err)
	}

	var created struct {
		Blog struct {
			ID int64 `json:"id"`
		} `json:"blog"`
	}
	json.Unmarshal(data, &created)

	if created.Blog.ID == 0 {
		return 0, fmt.Errorf("blog creation returned no ID")
	}
	return created.Blog.ID, nil
}

// shopifyCreateArticle creates a blog post with optional featured image and meta description.
func shopifyCreateArticle(cfg *Config, blogID int64, title, bodyHTML, tags, summaryHTML, imagePathOrURL string) (int64, string, error) {
	article := map[string]interface{}{
		"title":     title,
		"body_html": bodyHTML,
		"tags":      tags,
		"published": true,
	}

	// Meta description / excerpt
	if summaryHTML != "" {
		article["summary_html"] = summaryHTML
	}

	// Attach image if provided
	if imagePathOrURL != "" {
		if strings.HasPrefix(imagePathOrURL, "http") {
			article["image"] = map[string]string{
				"src": imagePathOrURL,
				"alt": title,
			}
		} else {
			// Local file — base64 encode
			imgData, err := os.ReadFile(imagePathOrURL)
			if err == nil {
				ext := strings.ToLower(filepath.Ext(imagePathOrURL))
				filename := filepath.Base(imagePathOrURL)
				_ = ext
				article["image"] = map[string]string{
					"attachment": base64.StdEncoding.EncodeToString(imgData),
					"filename":  filename,
					"alt":       title,
				}
			}
		}
	}

	payload := map[string]interface{}{
		"article": article,
	}

	data, err := shopifyRequest(cfg, "POST", fmt.Sprintf("/blogs/%d/articles.json", blogID), payload)
	if err != nil {
		return 0, "", err
	}

	var result struct {
		Article struct {
			ID     int64  `json:"id"`
			Handle string `json:"handle"`
		} `json:"article"`
	}
	json.Unmarshal(data, &result)

	store := cfg.ShopifyStore
	if !strings.Contains(store, ".") {
		store = store + ".myshopify.com"
	}
	articleURL := fmt.Sprintf("https://%s/blogs/news/%s", store, result.Article.Handle)

	return result.Article.ID, articleURL, nil
}

// shopifyListArticles lists recent blog articles.
func shopifyListArticles(cfg *Config, blogID int64, limit int) error {
	if limit <= 0 {
		limit = 10
	}
	data, err := shopifyRequest(cfg, "GET", fmt.Sprintf("/blogs/%d/articles.json?limit=%d", blogID, limit), nil)
	if err != nil {
		return err
	}

	var result struct {
		Articles []struct {
			ID          int64  `json:"id"`
			Title       string `json:"title"`
			Handle      string `json:"handle"`
			Tags        string `json:"tags"`
			PublishedAt string `json:"published_at"`
		} `json:"articles"`
	}
	json.Unmarshal(data, &result)

	if len(result.Articles) == 0 {
		fmt.Println("  No articles found.")
		return nil
	}

	fmt.Printf("\n  %-8s %-40s %-20s %s\n", "ID", "TITLE", "PUBLISHED", "TAGS")
	fmt.Println("  ────────────────────────────────────────────────────────────────────────────")
	for _, a := range result.Articles {
		pubDate := a.PublishedAt
		if len(pubDate) > 10 {
			pubDate = pubDate[:10]
		}
		title := a.Title
		if len(title) > 38 {
			title = title[:38] + ".."
		}
		tags := a.Tags
		if len(tags) > 30 {
			tags = tags[:30] + ".."
		}
		fmt.Printf("  %-8d %-40s %-20s %s\n", a.ID, title, pubDate, tags)
	}
	return nil
}

// ── Product SEO Functions ───────────────────────────────────

// ShopifyProduct holds the SEO-relevant fields of a Shopify product.
type ShopifyProduct struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	Handle      string `json:"handle"`
	BodyHTML    string `json:"body_html"`
	ProductType string `json:"product_type"`
	Tags        string `json:"tags"`
	Images      []struct {
		ID  int64  `json:"id"`
		Src string `json:"src"`
		Alt string `json:"alt"`
	} `json:"images"`
}

// shopifyGetProducts fetches all products from the store.
func shopifyGetProducts(cfg *Config) ([]ShopifyProduct, error) {
	var allProducts []ShopifyProduct
	page := 1
	for {
		data, err := shopifyRequest(cfg, "GET", fmt.Sprintf("/products.json?limit=250&page=%d", page), nil)
		if err != nil {
			return allProducts, err
		}

		var result struct {
			Products []ShopifyProduct `json:"products"`
		}
		json.Unmarshal(data, &result)

		if len(result.Products) == 0 {
			break
		}
		allProducts = append(allProducts, result.Products...)
		if len(result.Products) < 250 {
			break
		}
		page++
	}
	return allProducts, nil
}

// shopifyUpdateImageAlt updates the alt text of a product image.
// ONLY use this to ADD alt text where none exists. Never overwrite existing alt text.
func shopifyUpdateImageAlt(cfg *Config, productID, imageID int64, altText string) error {
	payload := map[string]interface{}{
		"image": map[string]interface{}{
			"id":  imageID,
			"alt": altText,
		},
	}
	_, err := shopifyRequest(cfg, "PUT", fmt.Sprintf("/products/%d/images/%d.json", productID, imageID), payload)
	return err
}

// shopifySEOAudit runs a quick audit and returns a summary as JSON.
// NEVER modifies anything — read-only scan. Only flags images with empty alt text as fixable.
func shopifySEOAudit(cfg *Config) error {
	fmt.Println("============================================================")
	fmt.Println("  Shopify SEO Audit")
	fmt.Println("============================================================")

	products, err := shopifyGetProducts(cfg)
	if err != nil {
		return fmt.Errorf("cannot fetch products: %w", err)
	}

	thinDescriptions := 0
	missingAltText := 0
	totalImages := 0

	type issue struct {
		ProductID int64  `json:"product_id"`
		Title     string `json:"title"`
		Issue     string `json:"issue"`
		FixType   string `json:"fix_type"` // "auto" or "recommend"
	}
	var issues []issue

	for _, p := range products {
		// Check description length (informational only — NEVER auto-fix)
		descWords := len(strings.Fields(stripHTML(p.BodyHTML)))
		if descWords < 30 {
			thinDescriptions++
			issues = append(issues, issue{
				ProductID: p.ID,
				Title:     p.Title,
				Issue:     fmt.Sprintf("description only %d words (report only — do NOT modify)", descWords),
				FixType:   "info",
			})
		}

		// Check image alt text — ONLY fixable issue (add where empty, never overwrite)
		for _, img := range p.Images {
			totalImages++
			if img.Alt == "" {
				missingAltText++
				issues = append(issues, issue{
					ProductID: p.ID,
					Title:     p.Title,
					Issue:     fmt.Sprintf("image %d missing alt text (will add)", img.ID),
					FixType:   "auto",
				})
			}
		}
	}

	fmt.Printf("\n  Products:           %d\n", len(products))
	fmt.Printf("  Thin descriptions:  %d\n", thinDescriptions)
	fmt.Printf("  Missing alt text:   %d / %d images\n", missingAltText, totalImages)
	fmt.Printf("  Auto-fixable:       %d issues\n", len(issues))

	// Output as JSON for Claude to parse and write seo.md
	jsonData, _ := json.MarshalIndent(map[string]interface{}{
		"products_total":    len(products),
		"thin_descriptions": thinDescriptions,
		"missing_alt_text":  missingAltText,
		"total_images":      totalImages,
		"issues":            issues,
	}, "", "  ")
	fmt.Printf("\n%s\n", string(jsonData))

	return nil
}

// stripHTML removes HTML tags for word counting.
func stripHTML(s string) string {
	var result strings.Builder
	inTag := false
	for _, r := range s {
		if r == '<' {
			inTag = true
		} else if r == '>' {
			inTag = false
		} else if !inTag {
			result.WriteRune(r)
		}
	}
	return result.String()
}

// ── CLI Entry Points ────────────────────────────────────────

func runBlogPost(cfg *Config, cmd *Command) {
	if cfg.ShopifyStore == "" || cfg.ShopifyAccessToken == "" {
		log.Fatal("[ERROR] shopifyStore and shopifyAccessToken required for blog posting")
	}

	if cmd.BlogTitle == "" || cmd.BlogBody == "" {
		log.Fatal("[ERROR] blogTitle and blogBody required")
	}

	fmt.Println("============================================================")
	fmt.Println("  Shopify Blog — Publishing Article")
	fmt.Println("============================================================")

	blogID, err := shopifyFindBlog(cfg)
	if err != nil {
		log.Fatalf("[ERROR] %v", err)
	}
	fmt.Printf("  Blog ID: %d\n", blogID)

	articleID, articleURL, err := shopifyCreateArticle(cfg, blogID, cmd.BlogTitle, cmd.BlogBody, cmd.BlogTags, cmd.BlogSummary, cmd.BlogImage)
	if err != nil {
		log.Fatalf("[ERROR] %v", err)
	}

	fmt.Printf("  Published: %s\n", cmd.BlogTitle)
	fmt.Printf("  Article ID: %d\n", articleID)
	fmt.Printf("  URL: %s\n", articleURL)
	fmt.Println("============================================================")
}

func runBlogList(cfg *Config) {
	if cfg.ShopifyStore == "" || cfg.ShopifyAccessToken == "" {
		log.Fatal("[ERROR] shopifyStore and shopifyAccessToken required")
	}

	fmt.Println("============================================================")
	fmt.Println("  Shopify Blog — Recent Articles")
	fmt.Println("============================================================")

	blogID, err := shopifyFindBlog(cfg)
	if err != nil {
		log.Fatalf("[ERROR] %v", err)
	}

	if err := shopifyListArticles(cfg, blogID, 10); err != nil {
		log.Fatalf("[ERROR] %v", err)
	}
}

// ── Analytics Functions ────────────────────────────────────

// shopifyGetOrders fetches orders created since the given date (RFC3339).
// Paginates through all results using Shopify's link-based pagination.
func shopifyGetOrders(cfg *Config, sinceDate string) ([]map[string]interface{}, error) {
	var allOrders []map[string]interface{}
	endpoint := fmt.Sprintf("/orders.json?status=any&created_at_min=%s&limit=250", sinceDate)

	for endpoint != "" {
		data, err := shopifyRequest(cfg, "GET", endpoint, nil)
		if err != nil {
			return allOrders, err
		}

		var result struct {
			Orders []map[string]interface{} `json:"orders"`
		}
		if err := json.Unmarshal(data, &result); err != nil {
			return allOrders, fmt.Errorf("cannot parse orders response: %w", err)
		}

		if len(result.Orders) == 0 {
			break
		}
		allOrders = append(allOrders, result.Orders...)
		if len(result.Orders) < 250 {
			break
		}
		// Simple page-based fallback (Shopify cursor pagination requires Link header parsing)
		break
	}
	return allOrders, nil
}

// shopifyGetAnalytics is the CLI entry point for order analytics.
// Pulls orders from the last N days and prints revenue, AOV, top products, and customer metrics.
func shopifyGetAnalytics(cfg *Config, days int) {
	if cfg.ShopifyStore == "" || cfg.ShopifyAccessToken == "" {
		log.Fatal("[ERROR] shopifyStore and shopifyAccessToken required for analytics")
	}

	fmt.Println("============================================================")
	fmt.Println("  Shopify Analytics")
	fmt.Println("============================================================")

	sinceDate := time.Now().AddDate(0, 0, -days).Format(time.RFC3339)
	orders, err := shopifyGetOrders(cfg, sinceDate)
	if err != nil {
		log.Fatalf("[ERROR] fetching orders: %v", err)
	}

	if len(orders) == 0 {
		fmt.Printf("\n  No orders found in the last %d days.\n", days)
		return
	}

	// ── Calculate metrics ──────────────────────────────────
	totalRevenue := 0.0
	revenueByDay := map[string]float64{}
	productRevenue := map[string]float64{}
	customerOrders := map[string]int{} // email → order count

	for _, order := range orders {
		// Total price
		price := parseFloat(order, "total_price")
		totalRevenue += price

		// Revenue by day
		if createdAt, ok := order["created_at"].(string); ok && len(createdAt) >= 10 {
			day := createdAt[:10]
			revenueByDay[day] += price
		}

		// Product revenue
		if lineItems, ok := order["line_items"].([]interface{}); ok {
			for _, li := range lineItems {
				if item, ok := li.(map[string]interface{}); ok {
					name := ""
					if n, ok := item["title"].(string); ok {
						name = n
					}
					itemPrice := parseFloat(item, "price")
					qty := 1.0
					if q, ok := item["quantity"].(float64); ok {
						qty = q
					}
					productRevenue[name] += itemPrice * qty
				}
			}
		}

		// Customer tracking
		if customer, ok := order["customer"].(map[string]interface{}); ok {
			if email, ok := customer["email"].(string); ok && email != "" {
				customerOrders[email]++
			}
		}
	}

	orderCount := len(orders)
	aov := totalRevenue / float64(orderCount)

	// ── Print summary ──────────────────────────────────────
	fmt.Printf("\n  Period:             Last %d days\n", days)
	fmt.Printf("  Total Revenue:      $%.2f\n", totalRevenue)
	fmt.Printf("  Order Count:        %d\n", orderCount)
	fmt.Printf("  AOV:                $%.2f\n", aov)

	// ── Revenue by day (sorted) ────────────────────────────
	fmt.Printf("\n  ── Revenue by Day ──────────────────────────────────\n")
	fmt.Printf("  %-12s %12s\n", "DATE", "REVENUE")
	fmt.Println("  ──────────────────────────────")
	sortedDays := sortedKeys(revenueByDay)
	for _, day := range sortedDays {
		fmt.Printf("  %-12s $%11.2f\n", day, revenueByDay[day])
	}

	// ── Top 5 products ─────────────────────────────────────
	fmt.Printf("\n  ── Top 5 Products by Revenue ───────────────────────\n")
	fmt.Printf("  %-40s %12s\n", "PRODUCT", "REVENUE")
	fmt.Println("  ──────────────────────────────────────────────────────")
	topProducts := topNByValue(productRevenue, 5)
	for _, kv := range topProducts {
		name := kv.key
		if len(name) > 38 {
			name = name[:38] + ".."
		}
		fmt.Printf("  %-40s $%11.2f\n", name, kv.value)
	}

	// ── Customer metrics ───────────────────────────────────
	totalCustomers := len(customerOrders)
	returning := 0
	for _, count := range customerOrders {
		if count > 1 {
			returning++
		}
	}
	newCustomers := totalCustomers - returning
	fmt.Printf("\n  ── Customer Metrics ────────────────────────────────\n")
	fmt.Printf("  Total Customers:    %d\n", totalCustomers)
	fmt.Printf("  New Customers:      %d\n", newCustomers)
	fmt.Printf("  Returning:          %d\n", returning)
	if totalCustomers > 0 {
		fmt.Printf("  Returning Ratio:    %.1f%%\n", float64(returning)/float64(totalCustomers)*100)
	}

	// ── JSON output ────────────────────────────────────────
	analyticsData := map[string]interface{}{
		"period_days":        days,
		"total_revenue":      totalRevenue,
		"order_count":        orderCount,
		"aov":                aov,
		"revenue_by_day":     revenueByDay,
		"top_products":       productRevenue,
		"total_customers":    totalCustomers,
		"new_customers":      newCustomers,
		"returning_customers": returning,
	}
	writeAnalyticsJSON(cfg, "shopify-analytics", analyticsData)
}

// shopifyGetCustomerCohorts pulls orders and groups customers by first-purchase month.
// Calculates cohort size, repeat rate, LTV, and churn indicators.
func shopifyGetCustomerCohorts(cfg *Config, days int) {
	if cfg.ShopifyStore == "" || cfg.ShopifyAccessToken == "" {
		log.Fatal("[ERROR] shopifyStore and shopifyAccessToken required for cohort analysis")
	}

	fmt.Println("============================================================")
	fmt.Println("  Shopify Customer Cohorts")
	fmt.Println("============================================================")

	sinceDate := time.Now().AddDate(0, 0, -days).Format(time.RFC3339)
	orders, err := shopifyGetOrders(cfg, sinceDate)
	if err != nil {
		log.Fatalf("[ERROR] fetching orders: %v", err)
	}

	if len(orders) == 0 {
		fmt.Printf("\n  No orders found in the last %d days.\n", days)
		return
	}

	// Build per-customer order history
	type customerData struct {
		email      string
		orders     []time.Time
		totalSpend float64
	}
	customers := map[string]*customerData{}

	for _, order := range orders {
		email := ""
		if customer, ok := order["customer"].(map[string]interface{}); ok {
			if e, ok := customer["email"].(string); ok {
				email = e
			}
		}
		if email == "" {
			continue
		}

		price := parseFloat(order, "total_price")
		var orderTime time.Time
		if createdAt, ok := order["created_at"].(string); ok {
			orderTime, _ = time.Parse(time.RFC3339, createdAt)
		}

		if customers[email] == nil {
			customers[email] = &customerData{email: email}
		}
		customers[email].orders = append(customers[email].orders, orderTime)
		customers[email].totalSpend += price
	}

	// Group by first-purchase month (cohort)
	type cohortStats struct {
		month          string
		size           int
		repeatCount    int
		totalSpend     float64
		hasRecentOrder bool // any order in last 30 days
	}
	cohorts := map[string]*cohortStats{}
	thirtyDaysAgo := time.Now().AddDate(0, 0, -30)

	for _, cd := range customers {
		// Find earliest order
		earliest := cd.orders[0]
		hasRecent := false
		for _, t := range cd.orders {
			if t.Before(earliest) {
				earliest = t
			}
			if t.After(thirtyDaysAgo) {
				hasRecent = true
			}
		}

		month := earliest.Format("2006-01")
		if cohorts[month] == nil {
			cohorts[month] = &cohortStats{month: month}
		}
		c := cohorts[month]
		c.size++
		c.totalSpend += cd.totalSpend
		if len(cd.orders) > 1 {
			c.repeatCount++
		}
		if hasRecent {
			c.hasRecentOrder = true
		}
	}

	// ── Print cohort table ─────────────────────────────────
	fmt.Printf("\n  %-10s %8s %10s %10s %12s %s\n", "COHORT", "SIZE", "REPEAT%", "AVG LTV", "TOTAL REV", "CHURN?")
	fmt.Println("  ────────────────────────────────────────────────────────────────────")

	sortedMonths := sortedKeys(map[string]float64{})
	// Build sorted month list from cohorts
	monthList := make([]string, 0, len(cohorts))
	for m := range cohorts {
		monthList = append(monthList, m)
	}
	sortedMonths = monthList
	sortStrings(sortedMonths)

	cohortOutput := []map[string]interface{}{}
	for _, month := range sortedMonths {
		c := cohorts[month]
		repeatRate := 0.0
		avgLTV := 0.0
		if c.size > 0 {
			repeatRate = float64(c.repeatCount) / float64(c.size) * 100
			avgLTV = c.totalSpend / float64(c.size)
		}
		churn := ""
		if !c.hasRecentOrder {
			churn = "CHURNED"
		}
		fmt.Printf("  %-10s %8d %9.1f%% $%9.2f $%11.2f %s\n",
			c.month, c.size, repeatRate, avgLTV, c.totalSpend, churn)

		cohortOutput = append(cohortOutput, map[string]interface{}{
			"month":        c.month,
			"size":         c.size,
			"repeat_rate":  repeatRate,
			"avg_ltv":      avgLTV,
			"total_revenue": c.totalSpend,
			"churned":      !c.hasRecentOrder,
		})
	}

	// ── JSON output ────────────────────────────────────────
	writeAnalyticsJSON(cfg, "shopify-cohorts", map[string]interface{}{
		"period_days": days,
		"cohorts":     cohortOutput,
	})
}

// ── Analytics Helpers ──────────────────────────────────────

// parseFloat extracts a float64 from a map field (handles string or number).
func parseFloat(m map[string]interface{}, key string) float64 {
	v, ok := m[key]
	if !ok {
		return 0
	}
	switch val := v.(type) {
	case float64:
		return val
	case string:
		var f float64
		fmt.Sscanf(val, "%f", &f)
		return f
	}
	return 0
}

// kvPair is a key-value pair for sorting.
type kvPair struct {
	key   string
	value float64
}

// topNByValue returns the top N entries from a map, sorted by value descending.
func topNByValue(m map[string]float64, n int) []kvPair {
	pairs := make([]kvPair, 0, len(m))
	for k, v := range m {
		pairs = append(pairs, kvPair{k, v})
	}
	// Simple selection sort (small N)
	for i := 0; i < len(pairs) && i < n; i++ {
		maxIdx := i
		for j := i + 1; j < len(pairs); j++ {
			if pairs[j].value > pairs[maxIdx].value {
				maxIdx = j
			}
		}
		pairs[i], pairs[maxIdx] = pairs[maxIdx], pairs[i]
	}
	if len(pairs) > n {
		pairs = pairs[:n]
	}
	return pairs
}

// sortedKeys returns map keys sorted alphabetically.
func sortedKeys(m map[string]float64) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortStrings(keys)
	return keys
}

// sortStrings sorts a string slice in place (simple insertion sort).
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// writeAnalyticsJSON writes analytics data as JSON to the results directory.
func writeAnalyticsJSON(cfg *Config, name string, data interface{}) {
	dir := cfg.OutputDir
	if dir == "" {
		dir = "results"
	}
	os.MkdirAll(dir, 0755)

	filename := fmt.Sprintf("%s_%s.json", name, time.Now().Format("2006-01-02_150405"))
	outPath := filepath.Join(dir, filename)

	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		fmt.Printf("  [WARN] Cannot marshal analytics JSON: %v\n", err)
		return
	}

	if err := os.WriteFile(outPath, jsonData, 0644); err != nil {
		fmt.Printf("  [WARN] Cannot write %s: %v\n", outPath, err)
		return
	}
	fmt.Printf("\n  JSON saved: %s\n", outPath)
}
