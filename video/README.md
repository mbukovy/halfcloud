# HalfCloud Product Film

A 30-second, 16:9 animated product film. HTML, CSS, inline SVG, and vanilla JavaScript in one file. No build, dependencies, backend, or video assets required.

The edit keeps the story deliberately quiet: short captions, simplified interface details, slower transitions, and longer still holds. Optional audio retains the sparse beat, bass, pads, chimes, and transition effects, but omits the repeating arpeggio.

Open `index.html` directly in a browser, or serve the repository root and visit `/video/`. Manrope and DM Mono load from Google Fonts; local fallback fonts work offline. All illustrations and the optional synthesized soundtrack are included in the HTML.

A pre-rendered 1920 x 1080, 30 fps MP4 is available at `halfcloud-product-video.mp4` and through the page's **Download MP4** link. It contains 900 actual Chromium screenshots encoded with H.264 (CRF 18), plus the original generated audio encoded as stereo AAC. It does not use DOM-to-SVG conversion or real-time screen capture.

## Playback

- Autoplays muted and stops on the final card at 30 seconds.
- Play/pause, scrubbing, chapter navigation, sound, and fullscreen controls.
- `Render MP4` records the film from frame zero with its generated audio and downloads `halfcloud-product-film.mp4`. In the browser picker, select **This Tab**; sharing tab audio is not required.
- Keyboard: Space to play/pause, Left/Right to seek two seconds, M for sound, F for fullscreen, R to replay. Focused controls keep their native keyboard behavior.
- Reduced-motion preference disables autoplay. Backgrounding the tab pauses playback.
- The film scales to fit desktop, mobile, and fullscreen without cropping.
- All messaging is on screen. Sound is optional; there is no voiceover.

## Scenes

| Time | Scene |
| --- | --- |
| 0-4s | The app assembles. An oversized orange address bar reveals `localhost:3000`. "You built it. What now?" The music drops out. |
| 4-8s | Four simple Docker, SSL, Ports, and Reverse proxy cards cover the app. No logs or explanatory copy. |
| 8-18s | An orange wipe reveals HalfCloud chat. A GitHub link and deployment request become a repo-to-VPS-to-HTTPS animation. |
| 18-24s | AwesomeApp opens on desktop and mobile with one visitor cursor. "Your app. Your server. Online." |
| 24-30s | The app folds into HalfCloud's split-cloud mark. "You vibe-coded it. Now vibe-deploy it." The GitHub CTA holds to the end. |

## Capture / Review

- `index.html?paused&t=16.9` opens a precise, paused frame.
- `index.html?clean` removes the surrounding page and player controls for screen recording. Keyboard controls still work.
- Combine them: `index.html?clean&paused&t=28`.
- For a 1920 x 1080 recording, use a 1920 x 1080 browser viewport in clean mode. Allow the fonts to load, press R to restart, and record 30 seconds. Enable sound with M first if desired.
- Native MP4 rendering requires a current Chrome or Edge release and takes 30 seconds in real time. Keep the tab visible until the download starts.

## Frame-by-Frame Render

`render.mjs` produces the downloadable file without recording dropped frames or player controls. It requires Playwright with Chromium and a full ffmpeg build supporting PNG input, libx264, and AAC. Font loading requires network access.

```bash
node video/render.mjs
```

An optional positional argument selects the output path. `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH`, and `FFMPEG_PATH` can point to externally installed tools; `RENDER_TMP` selects the directory for the temporary audio and reference screenshots. These tools are not required to play the HTML or download the existing MP4.

The demonstration app, domains, repository, visitor, and deployment timings are illustrative. The actual HalfCloud GitHub link is clickable. The SVG mark is a crisp recreation of the project's split-cloud logo; the colors, fonts, composer, and health indicator follow the existing product UI.
