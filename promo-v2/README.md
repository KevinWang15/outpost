# Promotional film v2

A 16:9, 1920 × 1080, 30 fps narrated film (about three minutes) for **Outpost**, the AI session manager. It follows AI agents across several dev servers, the rough edges of SSH, and how the manager solves them. Animated dev-server towers, floating session terminals, access devices, and connection beams illustrate the workflow alongside faithful light-theme replicas of the app UI.

The project includes editable scenes, screenshots, narration copy, and a measured animation timeline. Generated narration, music, and movie files stay local and are excluded from Git. The interactive player is available with `npm run preview` after generating audio.

## Story

| # | Scene | What you see |
| --- | --- | --- |
| 1 | AI coding today | Camera pulls back from Codex, Claude Code, and Kimi terminals to reveal three dev servers, each running several sessions. |
| 2 | The rough edges | An SSH beam snaps and the agent stops; a pasted screenshot bounces off a remote terminal; sessions on every server turn into question marks. |
| 3 | One place | The Outpost logo blooms; laptop and desktop rise, with beams to every session on every server. |
| 4 | Start a session | Pick a server, name it, choose the agent and folder (with suggestions), and auto-install a missing agent. |
| 5 | Connect | The dashboard zooms into Connect, and a terminal launches out of the button, attached to the live session. |
| 6 | Keeps running | The laptop lid closes and its beam fades, but the agent keeps working; later, the desktop reconnects to the finished work. |
| 7 | Share images | Ctrl+V into the manager, Send to session; the image arcs into the agent's prompt. |
| 8 | Find past conversations | Search, then the camera dives into the server: a scan ring sweeps the orbiting history, and only the matches lift out. |
| 9 | Know where you're needed | Every session shows working / idle / waiting; checking the waiting one clears its notice. |
| 10 | Simple by design | A ghost "manager service" dissolves before it docks; adapter modules slot onto a rail, with a custom harness snapping in last. |
| 11 | Outro | An orbit over the whole system converges into the Outpost logo, "AI Session Manager", and the tagline. |

## Audio

- **Voice:** ElevenLabs `eleven_multilingual_v2`, the premade voice *Eric*. There is one take per scene, recorded with neighbouring-scene context for natural continuity. Character timestamps drive every animation cue and caption.
- **Music:** ElevenLabs Music (`music_v1`), an instrumental composition plan whose sections (intro → tension → lift → groove → resolve) are cut to the measured narration timeline.
- **Mix:** narration normalised to −16 LUFS. Music ducks under speech with a sidechain compressor, then the mix goes through a limiter. English captions are burned into the picture and also included as a selectable `mov_text` track.

## Build

Requires Node 24+, npm 11+, and Playwright Chromium. Audio preview and movie export also require FFmpeg with libx264. From the repository root:

```sh
cd promo-v2
npm ci
npx playwright install chromium
npm run stills                  # one still per scene; works without audio or an API key
npm run poster                  # rebuild the outro poster with the shared logo

export ELEVENLABS_API_KEY=...    # needed to generate your own narration and score
npm run narrate                 # records missing or changed audio and updates the timeline
npm run music                   # composes a missing or changed score
npm run preview                 # serves the interactive player
npm run render                  # MP4 export; one worker by default, --from/--to for a segment
```

The committed timeline and screenshots are enough to render stills without an API key. Movie export needs locally generated audio. The key is read from the environment only and never written to disk. Review the provider's terms and your plan before publishing generated media; release assets or a separate host keep large movies out of source history. See [third-party notices](../THIRD_PARTY_NOTICES.md) for license scope.

Exports use one browser worker and two encoder threads by default; `--workers=N` opts into parallel rendering. On Linux with systemd, cap the entire process tree, including Chromium and FFmpeg, with:

```sh
systemd-run --scope -p CPUQuota=400% -p MemoryMax=4G \
  nice -n 15 npm run render -- --workers=1
```

This limits rendering to four logical CPUs and 4 GB of memory. It may require system-manager privileges. Refresh the app screenshots, stills, and poster before exporting the movie.

## Brand

The shared logo is [`../public/outpost.svg`](../public/outpost.svg): a rounded rectangular terminal around a `>_` prompt, with a Wi-Fi beacon in the top-right opening. Rendering copies it to [`assets/logo.svg`](assets/logo.svg) for offline playback. The work keeps running out at the outpost, and you check in from anywhere. The film and app show the name as **Outpost** with the descriptor **AI Session Manager**. With the repository's app dependencies installed, run `npm run promo:capture` from the repository root to refresh the four app screenshots in `assets/screenshots`. The capture uses synthetic targets and sessions on loopback port 4191; `OUTPOST_PROMO_PORT` overrides it. `OUTPOST_PROMO_CAPTURE_DIR` selects an alternate output directory.

## Where to edit

| Change | File |
| --- | --- |
| Narration copy, animation cue phrases, pauses | [`scripts/script.mjs`](scripts/script.mjs) |
| App screenshots and example data | [`scripts/capture.mjs`](scripts/capture.mjs), [`scripts/demo.mjs`](scripts/demo.mjs) |
| Scene choreography (camera, environment, UI, cursor) | [`src/scenes.js`](src/scenes.js) |
| Scene environment (servers, panels, devices, beams, particles) | [`src/world.js`](src/world.js), [`src/textures.js`](src/textures.js) |
| App UI replicas, headings, chips | [`src/ui.js`](src/ui.js), [`src/film.css`](src/film.css) |
| Transitions, captions, preview player | [`src/film.js`](src/film.js), [`src/captions.js`](src/captions.js) |
| Music plan, audio mix, export | [`scripts/music.mjs`](scripts/music.mjs), [`scripts/render.mjs`](scripts/render.mjs) |

Cue phrases must occur in the narration text. Changing cues or `hold` does not re-record speech; changing the text of a scene re-records that scene and its neighbours, because neighbouring text is part of each take's context.

## Content notes

All environment details are synthetic: `example.com` hosts, `/workspaces/demo-*` paths, and invented session titles. The four screenshots in `assets/screenshots` are captures of the app using the fixtures in `scripts/demo.mjs`; the capture script checks visible content before saving pixels. Terminal output, installation progress, and animated scenes are staged illustrations of the product's real behaviour: sessions persist on dev servers, Connect opens a local terminal attached to them, images are inserted into the agent prompt, search runs on the server and returns only matching excerpts, and servers run no resident manager service.

Fonts: Inter and JetBrains Mono (SIL OFL; licenses in `assets/fonts`). Icons: Lucide (ISC).
