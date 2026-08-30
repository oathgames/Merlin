---
name: merlin-video
description: Use when the user wants to edit, assemble, cut, or splice video — stitching clips into a finished piece, building a UGC or ad edit from supplied footage, adding burned-in captions or lower thirds, laying a music bed under interview audio, trimming to a hook, changing aspect ratio, animating an overlay, or reading/critiquing a video file they did not make. Covers video-ingest (seeing footage: scenes, frames, transcripts) and video-render (the EDL timeline format that compiles to one ffmpeg pass). Not for GENERATING new clips from a prompt (that is merlin-content) or for pushing a finished video to an ad platform (that is merlin-ads).
---

# Video editing

Two actions. Everything else is you reasoning over JSON in between.

| Action | Direction | What it does |
|---|---|---|
| `video-ingest` | file → facts | Probe, scene-detect, sample frames with burned timecodes, tile contact sheets, transcribe with word-level timings |
| `video-render` | EDL → file | Compile a timeline into ONE ffmpeg pass |

MCP tools: `mcp__merlin__video_ingest`, `mcp__merlin__video_render`.

Neither spends money. Neither touches a platform. Both are pure local file work,
so there is no approval card and no rate-limit bucket.

## The loop

1. **Ingest every source clip.** You cannot watch video. `video-ingest` is how you
   see it: it returns contact sheets you open with the Read tool, plus a transcript
   with timings. Do this before critiquing footage, choosing a soundbite, or
   picking a cut point. Guessing at content you have not looked at is the single
   most common way an edit comes back wrong.
2. **Write the EDL.** A JSON document describing the whole timeline.
3. **Show the EDL before rendering** when the user is going to care about the
   result. It reads like a shot list, so a human can correct a cut in the
   document rather than after a render.
4. **Render.** One pass, deterministic.
5. **Ingest your own render** and look at the contact sheet. This is the back-half
   critique. A caption colliding with a logo, a wrong-aspect clip, a dead frame at
   a transition: all of them are visible in the sheet and invisible in the exit code.
6. **Fix by editing the EDL and re-rendering.** Never by chaining another ffmpeg
   pass on the output.

## Why one pass matters

Every operation done as a separate ffmpeg call re-encodes the intermediate. A
six-clip cut done naively is seven h264 generations deep, and the last one looks
it. The EDL compiles the whole timeline into a single `filter_complex` graph, so
the source is decoded once and encoded once, no matter how many clips,
transitions, overlays, or caption cues are involved.

This is also why the fix for a bad render is always "edit the EDL", never "patch
the output file".

## EDL format

```json
{
  "format": "9:16",
  "fps": 30,
  "output": "C:/path/final.mp4",
  "clips": [
    { "source": "a.mp4", "in": 0.5, "out": 3.6, "fit": "cover", "gain": -8 },
    { "source": "b.mp4", "in": 1.0, "out": 3.5, "transition": "dissolve", "transitionDur": 0.5 },
    { "source": "card.jpg", "out": 3.0, "fit": "contain", "transition": "fade-black" },
    { "source": "c.mp4", "in": 0, "out": 3.9, "speed": 1.5, "transition": "wipe-left" }
  ],
  "audio": [
    { "source": "bed.m4a", "gain": -14, "loop": true, "fadeIn": 0.5, "fadeOut": 1.0, "duck": true }
  ],
  "captions": {
    "style": "hormozi",
    "cues": [ { "start": 0.2, "end": 2.8, "text": "one timeline" } ]
  }
}
```

**Top level.** `format` is `9:16` / `4:5` / `1:1` / `16:9` (or explicit
`width`/`height`). `fps` defaults to 30. `output` must end `.mp4` or `.mov`.
`crf` and `preset` tune the encode.

**Clips.** `in`/`out` are seconds INTO THE SOURCE, not positions on the timeline;
the timeline position is implied by order. A still image with no `out` gets 3
seconds. `fit` is `cover` (fill and crop, the default and almost always right),
`contain` (fit and letterbox), or `stretch` (distorts, essentially never
correct). `speed` is a multiplier, audio pitch-preserved. `gain` is dB.
`transition` applies BETWEEN this clip and the previous one and is one of `cut`
(default, free), `fade` / `dissolve`, `fade-black`, `wipe-left`, `wipe-right`.
Hyphens are optional.

**Audio.** Tracks mix over the whole timeline. `loop` repeats a short bed to
cover a long edit. `duck:true` pushes the bed down whenever there is speech,
which is the difference between a music bed and a music problem. `start` places
the track on the timeline; `in`/`out` trim the source.

**Overlays.** A still (logo, badge, endcard) composited on top, optionally
animated. `keys` is a list of `{t, x, y, ease}` positions; ease is `linear`,
`in`, `out`, or `inout`. One key means static. Values hold flat outside the key
range.

**Captions.** `hormozi` is 1-2 word bursts, large, centered high enough to
survive a 4:5 crop of a 9:16 master. `subtitle` is conventional lines near the
bottom. `lower-third` renders a styled speaker name above the quote. Cues carry
their own timings; whisper output from `video-ingest` drops straight in.

## Rules

- **Unknown field names are refused, not ignored.** A typo is an error rather
  than a silently wrong render. If the engine says a field is unknown, the field
  name is wrong, not the value.
- **Validation reports every problem at once.** Do not fix one field and re-run
  four times; read the whole list.
- **A transition eats time from both neighbours.** It must be shorter than both.
  The reported duration already subtracts the overlap, so a 3s + 3s pair with a
  1s dissolve is 5s, not 6s.
- **Timeline arithmetic is yours to get right.** Caption cues run against the
  FINISHED timeline, not any source clip. After changing a clip's length, re-time
  the cues.
- **Cover, not contain, unless the letterbox is the point.** Black bars on a
  paid social placement read as an error to the viewer.
- **Verify by looking.** Re-ingest the render and read the contact sheet. A
  successful exit code says ffmpeg ran, not that the edit is good.

## Sourcing footage

- Clips Merlin generated (fal / veo / heygen / arcads) are already local; ingest
  them like anything else.
- User-supplied footage goes in a folder; ingest each file once and keep the
  timeline JSON.
- For stock, use public-domain and royalty-free sources only, and record where
  each asset came from alongside the EDL. An edit whose provenance is unknown
  cannot ship to a paid placement.

## Data-driven assembly

When performance data exists, the cut is not a taste call:

- Hook rate picks the OPENING clip. The highest 3-second-hold opener goes first,
  whatever it was originally cut for.
- Retention curves pick the cut points. Where viewers drop is where the edit is
  too slow; tighten the `in`/`out` of the clip that spans the drop.
- Winning ads are sources, not templates. Ingest the winner, pull the specific
  seconds that held attention, and rebuild around them.

Read the transcript, not just the picture, when choosing soundbites. A line
reads well on the page and lands badly in delivery; the timings tell you which
take was clean.
