# VidSlide Yanhe v0.4.2 Batch Branch Notes

This branch is `yanhe/v0.4.2-batch` and is intentionally separate from `main`.
It focuses only on Yanhe classroom screen recordings and PPT extraction. Do not
merge in main-only classroom object types such as blackboard, hybrid classroom,
or electronic classroom processing unless the branch owner explicitly decides to
change the branch boundary.

## Workspace

Runtime data is managed under:

`%LOCALAPPDATA%\VidSlide\yanhe-batch-v0.4.2\`

Large Yanhe downloads default to:

`F:\VidSlide\yanhe-batch-v0.4.2\downloads`

If F: is unavailable, downloads fall back to the managed LocalAppData workspace.

Important subdirectories:

- `downloads/`: managed Yanhe downloads.
- `imports/`: browser drag/drop copies.
- `sessions/`: extraction and batch session cache.
- `chrome-profile/`: VidSlide's product Chrome profile.
- `config/settings.json`: persisted local settings.
- `logs/`: diagnostic logs. Do not write tokens or signed URLs here.

The existing getvideo profile can be reused during development:

`%LOCALAPPDATA%\YanhektDownloader\chrome-profile`

This is a migration convenience, not a product requirement. Never copy account
passwords, tokens, signed video URLs, or Chrome databases into the repo.

## Local Run

```powershell
cd "D:\the lab for html\VidSlide-v0.4.2-yanhe-batch"
python app.py --port 5882 --no-browser
```

Open:

`http://127.0.0.1:5882`

## Smoke Test Course

Use:

`https://www.yanhekt.cn/course/67968`

Expected course metadata as of 2026-05-02:

- Course ID: `67968`
- Course name: `生物仪器分析`
- Recordings returned: `16`

Safe dry-run command:

```powershell
$body = @{ course_input='https://www.yanhekt.cn/course/67968'; session_ids=@(853828); dry_run=$true } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:5882/api/yanhe/download-jobs' -ContentType 'application/json; charset=utf-8' -Body $body
Invoke-RestMethod -Uri "http://127.0.0.1:5882/api/yanhe/download-jobs/$($job.job.id)"
```

The dry run validates course loading, URL signing, HLS playlist parsing, and size
estimation without writing a video or adding anything to a batch. A recent dry
run for session `853828` estimated about `774.3 MB` and `297` segments.

Real download smoke result:

- Session: `853828`
- Output: `F:\VidSlide\yanhe-batch-v0.4.2\downloads\生物仪器分析_第7周_星期二_第4大节_课堂录屏.mp4`
- Size: about `759.5 MB`
- ffmpeg read: `1920x1080`, H.264 video, AAC audio, duration about `01:38:57`
- Batch behavior: added to batch unselected zone, batch remains `idle`

Duplicate-download smoke result:

- A new batch was created and session `853828` was requested twice.
- Because the MP4 already existed, both jobs completed quickly through the
  "exists" path.
- The batch stayed at exactly one item in `unselected`; `queue` and `completed`
  stayed empty. This verifies that repeated download actions do not duplicate
  the same source video in the batch workspace.

Short extraction smoke result:

- Sample source:
  `F:\VidSlide\yanhe-batch-v0.4.2\downloads\smoke_67968_5min.mp4`
- The sample is a 5-minute local clip cut from the real Yanhe download for
  session `853828`.
- Extraction settings stayed on the branch defaults: threshold `5`, ROI on,
  fast mode on, GPU requested, speed mode `fast`, classroom mode `ppt`.
- Result: completed in about `12s`, saved `4` slides, and moved to the batch
  completed zone.
- Export smoke: ZIP, PDF, and PPTX package downloads all returned HTTP `200`.
- This validates the product chain without changing the PPT extraction
  principle/algorithm.

Browser productization smoke result:

- Course `67968` loads as `生物仪器分析` with `16` recordings.
- The Yanhe first screen now shows flow state, total duration, selected count,
  selected duration, active profile mode, active ffmpeg source, and F-drive
  free space.
- Sorting by shortest-first puts session `853828` at the top; selecting it
  updates the selected duration to about `1小时38分`.
- Download completion shows a persistent action to go to the batch unselected
  zone. Clicking it shows one unselected video and no queue work, so extraction
  remains manual.
- Browser console still shows extension-origin and blocked third-party traffic
  unrelated to the app; app-origin smoke path passed.

Settings picker update:

- Added native picker endpoints:
  - `POST /api/settings/select-ffmpeg`
  - `POST /api/settings/select-download-dir`
- These reuse the existing Tkinter picker infrastructure. If a permission or
  window-focus prompt appears during manual use, handle it in the visible desktop
  rather than blocking the agent loop.
- The ffmpeg picker validates the selected file through `ffmpeg_status()` before
  saving it to settings.
- The download-directory picker creates the directory if needed, performs a
  write test, saves the path, and returns disk usage.
- Settings drawer now has "选择" buttons beside both path fields. Browser smoke
  verified the buttons render and current diagnostics still show bundled ffmpeg,
  F-drive downloads, and the getvideo development profile.
- Unit tests mock the native dialogs so CI/automation does not hang.

Batch workspace guidance update:

- The batch workspace now has a compact three-step strip directly above the
  zones: unselected, queue, completed/export.
- Zone headers now state the boundary that matters most for this branch:
  downloaded videos land in unselected, only queue videos are extracted, and
  completed videos should be checked before export.
- Runtime preset labels were toned down to `省电`, `均衡`, and `极速`, with
  clearer speed/accuracy tradeoff text.
- Batch export progress now has actual local CSS and remains visible briefly
  after completion with a completion message.
- Completed-detail single-video export now writes packaging progress/errors into
  the detail status line.
- Browser smoke verified the guide strip, calmer speed labels, zone subtitles,
  and progress-bar styling on the batch page.

## ffmpeg

Real downloads require ffmpeg. The app now:

- Blocks real download-job creation if ffmpeg is missing.
- Allows dry-run jobs without ffmpeg.
- Reports ffmpeg candidates in `/api/diagnostics/status`.
- Shows candidate buttons in the settings drawer.
- Prefers local sidecar `bin\ffmpeg.exe` when present.
- Validates configured ffmpeg paths before reporting them usable.

Local sidecar currently used during development:

`D:\the lab for html\VidSlide-v0.4.2-yanhe-batch\bin\ffmpeg.exe`

Do not commit ffmpeg binaries to this branch. The build scripts include
`bin\ffmpeg.exe` when it exists, so release artifacts can still be self-contained.

## Verification

Run before pushing:

```powershell
python -m unittest discover -s tests
python -m py_compile yanhe_download_manager.py yanhe_downloader_core.py storage.py settings_store.py app.py batch_manager.py extractor.py exporter.py tests\test_yanhe_branch.py
node --check static\js\main.js; node --check static\js\batch\core.js; node --check static\js\settings.js; node --check static\js\yanhe.js
rg -n "https://cdn|cdn\.jsdelivr|cdn\.tailwindcss|tailwindcss\.js" templates static --glob "!static/vendor/**"
```

The browser may show console errors from installed extensions or blocked third
party extension traffic. Treat app-origin errors separately.
