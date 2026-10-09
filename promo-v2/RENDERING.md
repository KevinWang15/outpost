# Rendering the movie with limited CPU

The full movie rendered in **1 hour 11 minutes** on 2026-10-09 while CPU and memory use were capped. This guide records the commands and measurements so future renders can leave capacity for other work.

## Prepare the assets

Follow the [build instructions](README.md#build) to install Node, npm, Playwright Chromium, and FFmpeg with libx264. From the repository root:

```sh
cd promo-v2
npm ci
npx playwright install chromium
```

Movie export requires the scene MP3s in `assets/narration/` and `assets/music/score.mp3`. These generated files are excluded from Git. Reuse existing audio when only the visuals change; if audio is missing, follow the README's `narrate` and `music` instructions with your own ElevenLabs API key.

Refresh app screenshots with `npm run promo:capture` from the repository root when the app or logo changes. Then, from `promo-v2`, check the inexpensive stills and poster before rendering the movie:

```sh
npm run stills
npm run poster
```

## Cap the entire render process

On Linux with systemd, run the following **from `promo-v2`**. It uses a system service, so the account needs permission to create systemd services; the recorded render ran as root.

```sh
systemd-run --wait --pipe --collect --unit=outpost-promo-render \
  -p CPUQuota=400% \
  -p MemoryHigh=3G -p MemoryMax=4G -p MemorySwapMax=0 \
  -p Nice=15 \
  --working-directory="$PWD" \
  "$(command -v node)" scripts/render.mjs --workers=1
```

- `CPUQuota=400%` caps combined CPU time at the equivalent of four logical CPUs. `200%` allows two; `800%` allows eight. This is a shared budget for the whole process tree, not a limit for each process or a selection of particular CPU IDs.
- `MemoryHigh=3G` applies memory pressure above 3 GB; `MemoryMax=4G` sets a hard 4 GB ceiling. Exceeding the ceiling can terminate processes in the render service. `MemorySwapMax=0` prevents this service from using swap.
- `Nice=15` lowers scheduling priority. It complements the quota; priority alone does not cap CPU use.
- `--workers=1` starts one browser worker. Chromium still creates multiple processes and threads, which are covered by the service limits. The renderer also uses two FFmpeg video encoder threads and one audio filter thread.
- `--wait --pipe` streams progress and waits for completion. systemd reports elapsed time and resource use when it finishes; `--collect` releases the transient unit afterwards.

Choose a quota that leaves spare capacity on your machine. The quota also covers Chromium's software WebGL rendering, FFmpeg audio mixing, and video encoding. Increasing `--workers` can increase memory use; keep one worker when resources are limited.

For an initial ten-second check, append `--from=0 --to=10` to the render command. This writes `output/segment.mp4`; a full render writes `output/outpost-promo-v2.mp4`. Segment checks do not resume into a full render.

While a full render is running, inspect it from another terminal:

```sh
systemctl show outpost-promo-render.service \
  -p CPUQuotaPerSecUSec -p CPUUsageNSec -p MemoryCurrent -p MemoryPeak
```

The renderer prints its completed frame count, average frames per second, and estimated remaining time every 300 frames. CPU time sums work across threads, so it can exceed elapsed wall time.

## Measured runtime

The 2026-10-09 render used a Linux host with **48 logical CPUs and 62 GiB RAM**, one browser worker, a 4 GB memory ceiling, and priority 15. It began with `CPUQuota=400%` and was raised to `800%` after checking available host capacity. CPU affinity was also restricted during the run, first to four and then to eight logical CPUs. The timing therefore reflects a run with changing limits, not a fixed four- or eight-CPU benchmark.

The output was **1920 × 1080 at 30 fps**, with **5,428 frames** and a duration of **180.93 seconds**. Existing narration and music were reused.

| Measurement | Result |
| --- | --- |
| Full render, including audio mixing and setup | **1 h 11 min 15 s** |
| Renderer's `Done in` time, measured after audio mixing | 4,241 s (1 h 10 min 41 s) |
| Total CPU time across the render service | 4 h 49 min 14 s |
| Peak memory / peak swap | 1.2 GB / 0 bytes |
| Master MP4 size | 64,793,042 bytes (61.79 MiB) |
| Creating the smaller sharing copy | **2 min 14 s** |
| Sharing-copy peak memory | About 515 MB |
| Sharing-copy size | 9,791,249 bytes (9.34 MiB) |

The main render plus sharing encode took about **1 h 13 min 29 s**, excluding dependency installation, asset capture, validation, and upload. A lower CPU quota, a slower host, or changed scenes can increase the time. Check the renderer's progress estimate rather than assuming this measurement applies to every machine.

## Create a smaller sharing copy

After the master finishes, run this **from `promo-v2`**. This is the same encoding configuration used for the measured sharing copy, with a four-CPU budget and a 2 GB memory ceiling:

```sh
systemd-run --wait --pipe --collect --unit=outpost-promo-share \
  -p CPUQuota=400% -p MemoryMax=2G -p MemorySwapMax=0 -p Nice=15 \
  --working-directory="$PWD" \
  "$(command -v ffmpeg)" \
  -nostdin -y -hide_banner -loglevel error \
  -filter_threads 1 -threads 2 -i output/outpost-promo-v2.mp4 \
  -map 0 -c:v libx264 -preset medium -crf 32 \
  -maxrate 350k -bufsize 700k -pix_fmt yuv420p -threads 4 \
  -c:a aac -ar 48000 -b:a 96k -c:s copy -movflags +faststart \
  output/outpost-promo-v2-github.mp4
```

This retains the resolution, frame rate, and subtitle track while lowering video and audio bitrates. Keep the master for higher-quality distribution. File size depends on the movie content; the recorded sharing copy was below 10 MiB. Both movie files remain local and are excluded from Git.
