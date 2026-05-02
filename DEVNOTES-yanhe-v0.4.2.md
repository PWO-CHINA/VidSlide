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

Branch management:

- Draft PR: `https://github.com/PWO-CHINA/VidSlide/pull/1`
- Alpha tag: `yanhe-v0.4.2-alpha.1`
- Published prerelease: `https://github.com/PWO-CHINA/VidSlide/releases/tag/yanhe-v0.4.2-alpha.2`
- Published prerelease assets:
  - `VidSlide-yanhe-v0.4.2-alpha.2.exe` (`173,349,849` bytes)
  - `THIRD_PARTY_NOTICES.md`
- The PR is a branch management and review anchor only. Do not merge this branch
  into `main` until the branch owner explicitly decides to do so.

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

Resource policy update:

- `/api/system/status` still reports soft warnings such as high memory. This is
  useful for user awareness and product diagnostics.
- Starting sessions/batch work now hard-blocks only on more severe conditions:
  extreme CPU pressure, extreme memory pressure plus very low available memory,
  or low disk space.
- Regression tests cover:
  - 92% memory with enough available memory does not block.
  - 98% memory with very low available memory blocks.
  - Low disk space blocks.
- Real smoke used `smoke_67968_30s.mp4`, a 30-second clip from the downloaded
  Yanhe recording. Batch start succeeded and extraction completed in about `1s`
  with `1` slide saved.

Mobile layout update:

- The sticky header now wraps safely below `760px` wide screens. The workspace
  switch, settings/shutdown buttons, and resource bar no longer force horizontal
  page overflow.
- `body` now hides accidental horizontal overflow, while the workspace switch can
  scroll inside its own row if a very narrow browser cannot fit every control.
- Browser smoke at a phone-sized viewport verified the Yanhe first screen, the
  batch workspace, and the settings drawer all report no horizontal overflow.
- Screenshots captured during verification:
  - `vidslide-mobile-yanhe-fixed.png`
  - `vidslide-mobile-batch-fixed.png`
- Post-alpha settings polish made the settings drawer full-width on narrow
  screens, added a sticky drawer title bar, and clarified the ffmpeg, F-drive
  download directory, getvideo profile, and source-cleanup settings in plain
  product copy.
- Browser smoke captured `vidslide-mobile-settings-polish.png` and verified no
  horizontal overflow or overflowing controls in the settings drawer.

Download/SSE regression update:

- Download job SSE now closes immediately for late subscribers when the job is
  already in a terminal state (`completed`, `error`, or `cancelled`). The init
  event still carries the final job snapshot, so a reconnecting UI can render
  the correct final state without waiting for heartbeats.
- Regression tests now cover terminal-event delivery, late terminal subscribers,
  and cleanup of download SSE queues.
- A manager-level mocked download test verifies that an already-existing MP4 is
  added to batch `unselected` once, leaves `queue` and `completed` empty, and
  does not start batch extraction.
- Runtime smoke after restarting the local server on port `5882` loaded course
  `67968`, returned `16` recordings for `生物仪器分析`, completed a dry-run job for
  session `863057`, and confirmed the late terminal SSE endpoint returns the
  final init event and closes immediately.

PPT animation stability regression update:

- Verified `extractor.py` against `rollback/v0.4.1`; the only branch diff is the
  version string. The v0.6.x classroom/blackboard/hybrid/PyAV/MOG2 extraction
  core has not been imported into this Yanhe branch.
- Root cause for captured PPT animation intermediate frames was batch parameters,
  not extractor drift. The active user batch metadata had `threshold=3` and
  `speed_mode=turbo`.
- In the v0.4.1 extractor, `turbo` uses 2-second stepping, 320px comparison, and
  a 1-sample stable-frame check. That is intentionally less conservative and can
  capture PPT animation mid-states.
- Yanhe batch params are now normalized at API, batch create/update, recovered
  metadata, worker-start, and frontend preference boundaries. Batch extraction
  allows only `eco` or `fast` and always forces `classroom_mode=ppt`.
- Regression tests cover API param normalization, batch create/update
  normalization, and recovery of legacy `batch.json` files that still contain
  `speed_mode=turbo`.
- Built local candidate `dist\VidSlide-yanhe-v0.4.2-alpha.3.exe` with bundled
  ffmpeg and PyInstaller runtime extraction directed to
  `F:\VidSlide\pyinstaller-runtime` because C: had reached zero free bytes.
- Alpha.3 smoke on port `5885` verified diagnostics/root page availability and
  created a test batch with `speed_mode=turbo` plus `classroom_mode=blackboard`;
  the API returned `speed_mode=fast` and `classroom_mode=ppt`. The temporary
  test batch and test process were cleaned up.

Batch detail thumbnail index regression update:

- Fixed completed-video detail preview after image deletion. The root cause was
  stale thumbnail click handlers capturing the original render index; after
  deleting an earlier image, the visible thumbnail moved but still opened the
  old index.
- Thumbnail open/delete now resolve the current image index from the thumbnail's
  `data-filename`, and drag-sort synchronization rebuilds `_batchDetailImages`
  from the current grid order.
- A follow-up review found the same class of bug during fast consecutive
  deletes: a removing card can remain in the DOM during its transition. DOM
  removal now locates the card by `data-filename` instead of `grid.children[idx]`,
  and disables pointer events on removing cards.
- Added a frontend regression test to prevent reintroducing the stale
  `idx`-closure pattern.

Yanhe PPT extraction parameter audit:

- Rechecked the batch extraction path. `extractor.py` still matches
  `rollback/v0.4.1` except for the version string; this branch has not imported
  the v0.6.x blackboard/electronic-classroom/PyAV/MOG2 extraction core.
- The batch path remains: downloaded/imported video enters unselected, user moves
  it to queue, `/api/batch/<id>/start` normalizes Yanhe params, then
  `batch_manager._video_worker()` calls `extract_slides()` with the v0.4.1 PPT
  recording algorithm.
- Current safe default for formal Yanhe batch extraction is `threshold=5`,
  `use_roi=true`, `fast_mode=true`, `use_gpu=true`, `enable_history=true`,
  `max_history=5`, `speed_mode=fast`, and `workers=1`.
- The main inherent risks are still the v0.4.1 tradeoffs: 1-second sampling can
  miss slides shown for less than about a second, hard-coded Yanhe ROI can miss
  nonstandard layouts, and stable bullet animations can be saved as valid states
  if they pause long enough.
- Kept the extraction core unchanged. Instead, batch param normalization now
  clamps numeric/bool inputs, rejects `turbo`, forces `classroom_mode=ppt`, and
  migrates legacy unversioned batch params with `threshold < 4.5` back to the
  formal default of `5.0`.
- Batch resume now reports and persists `saved_offset + newly_saved` rather than
  only the images saved after resume, preventing total-image counts from drifting
  after interrupted batch work.

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
See `docs/yanhe-release-packaging.md` for the release checklist and license
reminder.

Packaging compatibility update:

- Runtime resource discovery now also checks Nuitka's `__compiled__.containing_dir`
  when present, in addition to PyInstaller `_MEIPASS`, the exe/app directory, and
  the source directory.
- The README now documents the v0.4.2 Yanhe flow, the F-drive download default,
  and the local `bin\ffmpeg.exe` release strategy.
- Local verification confirmed `bin\ffmpeg.exe -version` works. The current local
  binary is a Gyan.dev full build with GPL-enabled configuration, so public
  release notes should include the matching ffmpeg license/source notice.
- Added `docs/THIRD_PARTY_NOTICES.md` for the bundled FFmpeg executable. The
  local Gyan.dev binary reports `--enable-gpl --enable-version3`, so release
  notes should treat it as GPLv3-or-later and include source/legal links.
- Built a local PyInstaller candidate:
  `dist\VidSlide-yanhe-v0.4.2-alpha.1.exe` (`173,348,247` bytes).
- Exe smoke on port `5883` verified:
  - `/api/diagnostics/status` finds bundled ffmpeg at the PyInstaller `_MEI...\bin\ffmpeg.exe` path.
  - The root page loads and contains the post-alpha settings copy.
  - Course `67968` loads as `生物仪器分析` with `16` recordings.
  - A dry-run job for session `863057` completes with progress `100`.
  - Late terminal SSE returns the final init snapshot and closes.
- The generated `build/`, `dist/`, and `.spec` files remain ignored and were not
  committed.
- `yanhe-v0.4.2-alpha.2` was tagged after the FFmpeg notice update and published
  as a GitHub prerelease. The uploaded exe asset SHA-256 reported by GitHub is
  `dd21d1dff84522c1fcacbcf4a687e795855f42fb9f5f928671f9f920b92b0103`.
- Published alpha.2 exe non-dry-run smoke:
  - Started on port `5884`.
  - Requested course `67968`, session `853828`, `dry_run=false`.
  - The already-present MP4 was detected through the `exists` path; no large
    re-download was performed.
  - Job `533ff7f1b3` completed with progress `100`.
  - Batch `d1c90a73` stayed `idle` with `unselected=1`, `queue=0`,
    `completed=0`.

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
