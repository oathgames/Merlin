  ____  ____
 |  _ \|___ \
 | |_) | __) |
 |  _ < / __/
 |_| \_\_____|

  ( ◕ ◡ ◕ )  Your AI CMO

Generate ads, manage campaigns, write SEO blogs, run competitor intel.
All from one command.

SETUP

  1. Download this repo (or ask Claude to do it):
     https://github.com/oathgames/R2
  2. Open the folder in Claude Code
  3. Type: /cmo

  That's it. /cmo handles everything else — downloads the binary,
  sets up your config, walks you through brand setup. The only thing
  you need is a fal.ai API key (free tier: https://fal.ai).

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

UPDATES
  Type: /update
  Downloads the latest binary + framework files from GitHub.
  Your brand data, config, and memory are never touched.

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

API KEYS
  fal.ai is the only required key (configured during /cmo setup).
  Everything else is optional and configured when you need it:

    /cmo push to Meta       → asks for Meta token
    /cmo push to TikTok     → asks for TikTok token
    /cmo write a blog post  → asks for Shopify token
    /cmo clone my voice     → asks for ElevenLabs key
