     _         _         ____ __  __  ___
    / \  _   _| |_ ___  / ___|  \/  |/ _ \
   / _ \| | | | __/ _ \| |   | |\/| | | | |
  / ___ \ |_| | || (_) | |___| |  | | |_| |
 /_/   \_\__,_|\__\___/ \____|_|  |_|\___/

  Autonomous AI CMO — v0.1.2

Replace your marketing team with an AI-powered Claude Code plugin.
Generate ads, manage campaigns, write SEO blogs, run competitor intel.

PREREQUISITES
  - Claude Code (https://claude.ai/code)
  - A fal.ai API key (https://fal.ai — free tier available)

QUICK START
  1. Download the latest release for your platform:
     https://github.com/oathgames/AutoCMO/releases/latest

     Windows:  AutoCMO-windows-amd64.exe
     macOS:    AutoCMO-darwin-arm64 (Apple Silicon) or AutoCMO-darwin-amd64 (Intel)
     Linux:    AutoCMO-linux-amd64

  2. Place the binary in this folder at: .claude/tools/AutoCMO.exe
     (On macOS/Linux, rename it to AutoCMO.exe — yes, keep the .exe extension)

  3. Copy .claude/tools/autocmo-config.example.json to .claude/tools/autocmo-config.json
     Add your fal.ai API key to the "falApiKey" field.

  4. Open this folder in Claude Code
  5. Type: /cmo

  First run walks you through brand setup — auto-imports products from your website.

macOS NOTE
  If macOS blocks the binary, /cmo handles it automatically.
  Or manually run:
    xattr -d com.apple.quarantine .claude/tools/AutoCMO.exe
    codesign --force --sign - .claude/tools/AutoCMO.exe

WHAT YOU CAN DO
  Just talk naturally:

    /cmo cream-set product video
    /cmo pink-set make 3 image variations
    /cmo clone my voice
    /cmo check Meta performance
    /cmo write a blog post about the bonefish hoodie
    /cmo push to Meta
    /cmo check TikTok performance
    /cmo archive old results

ADDING PRODUCTS
  Create a folder under assets/brands/<brand>/products/ with a references/ subfolder.
  Drop product photos in it. Claude handles the rest.

    assets/brands/mybrand/products/new-jacket/references/photo1.jpg

  Next time you run /cmo new-jacket, it just works.

QUALITY BENCHMARKS
  Drop 3-5 high-quality ad examples into assets/brands/<brand>/quality-benchmark/.
  Claude scores every generated image/video against these.

VOICE CLONING
  Drop 1-3 audio recordings (.mp3/.wav) into assets/brands/<brand>/voices/.
  Then: /cmo clone my voice

AVATARS
  Drop a photo (.jpg/.png) or video (.mp4) into assets/brands/<brand>/avatars/.
  Photos use HeyGen talking-head mode. Videos use Kling lip-sync.

SEO BLOGS
  /cmo write a blog post — auto-generates and publishes to Shopify.
  Runs daily if Shopify is configured.

META ADS
  /cmo push to Meta          — uploads to Testing campaign ($5/day)
  /cmo check Meta performance — CTR, CPC, ROAS, winner/loser flags

TIKTOK ADS
  /cmo push to TikTok          — uploads to Testing campaign ($5/day)
  /cmo check TikTok performance — CTR, CPC, ATC, winner/loser flags

UPDATES
  AutoCMO self-updates. Type: /cmo update
  Or run: AutoCMO.exe --action update

API KEYS (add to autocmo-config.json)
  Required:  falApiKey (fal.ai — image/video generation)
  Optional:  slackWebhookUrl, slackBotToken, slackChannel (Slack delivery)
             metaAccessToken, metaAdAccountId, metaPageId (Meta Ads)
             tiktokAccessToken, tiktokAdvertiserId (TikTok Ads)
             shopifyStore, shopifyAccessToken (SEO blogs)
             elevenLabsApiKey (voice cloning)
             heygenApiKey (avatar videos)
             googleApiKey (Gemini fallback)
