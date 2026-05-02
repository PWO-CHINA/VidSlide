# VidSlide v0.4.2 Yanhe Batch Implementation Plan

This file is the durable handoff plan for the `yanhe/v0.4.2-batch` branch.
It exists so the implementation can survive context compaction or a future
handoff without losing decisions.

## Current State

- Target directory: `D:\the lab for html\VidSlide-v0.4.2-yanhe-batch`
- Branch: `yanhe/v0.4.2-batch`
- Remote: `origin` -> `https://github.com/PWO-CHINA/VidSlide.git`
- Remote branch has been created and upstream is set.
- Source downloader project is read-only reference: `D:\the lab for html\getvideo`
- Existing `getvideo` Yanhekt profile was checked and is usable:
  `%LOCALAPPDATA%\YanhektDownloader\chrome-profile`
- Product branch boundary: this branch is only for Yanhe classroom recording /
  PPT extraction. Do not import main's blackboard, hybrid, electronic classroom,
  or other newer processing objects.

## Implementation Goals

- Build a local web workspace for:
  course URL -> Yanhe course list -> selected VGA downloads -> batch unselected
  zone -> manual queue processing -> preview -> export.
- Keep the frontend Flask + Vanilla JS. Do not add React/Vue.
- Keep data local. Do not save account passwords, tokens, or signed URLs.
- Use managed workspace storage under:
  `%LOCALAPPDATA%\VidSlide\yanhe-batch-v0.4.2\`
- Default product profile should be VidSlide's own Chrome profile, while the
  existing `getvideo` profile can be used during development and migration.

## Milestones

1. Git checkpoint and remote branch
   - Push `yanhe/v0.4.2-batch` to origin and set upstream.
   - Keep milestone commits small and push after each verified stage.

2. Storage and settings
   - Add `storage.py`.
   - Add `settings_store.py`.
   - Workspace subdirs: `downloads`, `imports`, `chrome-profile`, `config`,
     `sessions`, `logs`.
   - Cleanup APIs must only delete managed paths.

3. Yanhe downloader core
   - Copy/adapt core logic from `getvideo/yanhekt_downloader.py`.
   - Include Chrome discovery, CDP client, course list JS, URL signing JS,
     ffmpeg discovery, filename planning, and ffmpeg progress.
   - Keep `getvideo` repo unchanged.

4. Download manager and APIs
   - Add `yanhe_download_manager.py`.
   - Job states: `planning`, `login_needed`, `downloading`, `completed`,
     `error`, `cancelled`.
   - Add SSE for download jobs.
   - Completed downloads should add videos to batch unselected zone, never
     auto-start extraction.

5. Flask integration
   - Add settings/storage/Yanhe/import/diagnostics routes to `app.py`.
   - Keep existing single-video and batch APIs compatible.
   - Add managed browser drag/drop import endpoint.

6. Frontend workspace
   - Rebuild the page around three workspaces: Yanhe Course, Batch Extract,
     Single Video.
   - Add right settings drawer.
   - Add course URL input, session list selection, download progress, and
     downloaded-to-unselected feedback.
   - Preserve current batch three-zone behavior.

7. Local assets and UI polish
   - Remove runtime CDN dependency.
   - Vendor Lucide and Sortable under `static/vendor/`.
   - Replace Tailwind CDN with committed local generated CSS or project CSS.
   - Use restrained local-tool styling and reduced-motion-safe interactions.

8. Diagnostics and performance
   - Add concise top-level hardware recommendation.
   - Add detailed settings diagnostics for CPU, memory, disk, GPU monitor,
     ffmpeg, Chrome, login state, workspace writability, and external assets.
   - Track extraction performance metadata per task when practical.

9. Tests and docs
   - Run `py_compile` for all Python modules.
   - Add unit tests for storage/settings/path guards and downloader helpers.
   - Add mocked downloader/job tests where feasible.
   - Run Playwright/browser checks for the rewritten UI if the dev server runs.
   - Update README/DEVNOTES for branch usage and privacy boundaries.

## Public APIs To Implement

- `GET /api/settings`
- `PATCH /api/settings`
- `GET /api/storage/status`
- `POST /api/storage/open`
- `POST /api/storage/cleanup`
- `GET /api/yanhe/login/status`
- `POST /api/yanhe/login/start`
- `POST /api/yanhe/login/use-getvideo-profile`
- `POST /api/yanhe/login/clear`
- `POST /api/yanhe/course/load`
- `POST /api/yanhe/download-jobs`
- `GET /api/yanhe/download-jobs/<job_id>`
- `GET /api/yanhe/download-jobs/<job_id>/events`
- `POST /api/yanhe/download-jobs/<job_id>/cancel`
- `POST /api/import-video`
- `GET /api/diagnostics/status`

## Safety Rules

- Never read the main Chrome profile database.
- Never write tokens, passwords, or signed URLs to logs, docs, settings, git, or
  packaged output.
- `.gitignore` must exclude managed runtime data, large videos, Chrome profile,
  imports, downloads, sessions, logs, build outputs, and release artifacts.
- Cleanup must be guarded by resolved-path checks against the managed workspace.
- If real Yanhekt login expires or requires manual verification, stop and report
  `login_required`; do not bypass access control.

## Current Progress

- M1 is complete: remote branch created and upstream set.
- M2 backend foundation is complete:
  - `storage.py` added.
  - `settings_store.py` added.
  - `/api/settings` and `/api/storage/*` routes added.
  - runtime data ignores added to `.gitignore`.
  - `py_compile` passed for current backend modules.
  - Flask test client passed settings/storage smoke checks.
- M3/M4 backend integration is complete:
  - `yanhe_downloader_core.py` copied/adapted from getvideo.
  - `yanhe_download_manager.py` added.
  - Yanhe login/course/download/import/diagnostics API routes added.
  - `py_compile` passed after these additions.
  - `/api/yanhe/login/status` verified usable with the existing getvideo profile.
- M5/M6 frontend workspace is in progress:
  - `templates/index.html` now has explicit `延河课程 / 批量提取 / 单视频` workspace switching.
  - Default first screen is the Yanhe course workspace; single-video sessions are created lazily only when entering the single-video workspace.
  - `static/js/yanhe.js` loads real Yanhe course lists, defaults to no selected recordings, and checks ffmpeg before creating download jobs.
  - `static/js/settings.js` adds the settings drawer wiring, storage/diagnostics display, login checks, and manual ffmpeg path setting.
  - Diagnostics now returns ffmpeg candidates, including read-only `getvideo` development candidates when present; the settings drawer can fill a candidate path into settings.
  - `static/js/batch/core.js` now hides/shows the three workspaces cleanly and initializes batch only on demand.
  - Runtime CDN usage was removed from app templates; Sortable, Lucide, and generated Tailwind CSS are under `static/vendor/`.
- M6/M7 download reliability update:
  - Default managed download directory now moves to `F:\VidSlide\yanhe-batch-v0.4.2\downloads` when F: exists, while config/sessions/profile stay under `%LOCALAPPDATA%`.
  - A local sidecar `bin\ffmpeg.exe` is supported and preferred as bundled ffmpeg; the binary is ignored by Git and should be supplied in local/release artifacts.
  - `find_ffmpeg()` now validates configured paths instead of returning nonexistent paths as usable.
  - Build scripts include `bin\ffmpeg.exe` when it exists, so release builds can be made self-contained without committing the binary.
- M7/M8 validation has started:
  - Real course smoke target: `https://www.yanhekt.cn/course/67968`.
  - Course load succeeds for course `67968` / `生物仪器分析`, returning 16 recordings with the existing getvideo profile.
  - Dry-run download job succeeds for session `853828`, validating signing and HLS size estimation without writing video; estimated size was about `774.3 MB` across 297 segments.
  - Real download now succeeds for session `853828`; output file was written to `F:\VidSlide\yanhe-batch-v0.4.2\downloads`, about `759.5 MB`, readable by ffmpeg as 1080p H.264/AAC.
  - Download completion adds the video to batch unselected zone in batch `6e912dd6`; batch status remains `idle`, proving download does not auto-start extraction.
  - Download job preflight now blocks missing ffmpeg before creating a job; real downloads also check estimated HLS size against disk free space plus a 512 MB reserve.
  - Added `tests/test_yanhe_branch.py` for workspace guards, settings round trip, downloader helpers, and dry-run preflight.
  - `python -m unittest discover -s tests`, `py_compile`, JS `node --check`, and CDN scans pass.
- M6/M8 productization and chain validation update:
  - Yanhe first screen now has a live flow strip: course -> download -> unselected zone -> manual extraction -> export.
  - Course load shows recording count, total duration, selected count, and selected duration.
  - Recording list supports title search and sorting by newest, oldest, or shortest-first.
  - Top status pills now expose the active login profile mode, active ffmpeg source, and F-drive download free space.
  - Settings drawer now highlights the currently effective ffmpeg candidate and explains F-drive storage/profile mode.
  - Download completion shows a persistent "go to unselected zone" action and advances the flow state without auto-starting extraction.
  - Batch video insertion now skips duplicate absolute video paths, preventing repeated "download existing file" actions from adding duplicate unselected entries.
  - Browser smoke on course `67968` verified the productized UI, sorting, selected-duration stats, settings drawer, and download-complete handoff.
  - API smoke verified downloading the already-present session `853828` twice leaves the target batch with exactly one unselected video.
  - Real extraction smoke used a local 5-minute clip cut from the downloaded Yanhe MP4. With the existing extractor settings and unchanged extraction principle, it completed in about 12 seconds, saved 4 slides, and ZIP/PDF/PPTX exports downloaded successfully.
- M6 settings usability update:
  - Added native settings picker APIs for `ffmpeg.exe` and the Yanhe download directory.
  - Settings drawer now has "选择" buttons next to both path fields. Successful selection persists settings and refreshes diagnostics/status.
  - The ffmpeg picker validates the selected executable through the existing ffmpeg status path before saving.
  - The download directory picker creates/checks a small write-test file before saving and returns disk free space.
  - Added tests covering both picker APIs with mocked native dialogs.
- M6 batch workspace guidance update:
  - Batch page now has a compact three-step strip: unselected -> queue -> completed/export.
  - Zone headers now make the manual boundary explicit: downloads land in unselected, only queue items are extracted, completed items should be reviewed/exported.
  - Runtime mode labels were toned down to product-facing language: Eco, balanced Fast, and Turbo.
  - Batch export progress bar now has local CSS and stays visible briefly after completion instead of disappearing immediately.
  - Single-video export from the completed detail view now reports packaging progress and errors in the detail status line.
- M7 resource policy update:
  - Soft resource warnings remain visible through `/api/system/status`.
  - Task creation/start hard blockers now trigger only on extreme CPU pressure, extreme memory pressure with very low available memory, or low disk space.
  - Added regression tests for soft-high-memory non-blocking behavior, extreme memory blocking, and low disk blocking.
  - Real 30-second Yanhe sample smoke verified batch start is allowed under normal pressure and completed in about 1 second.
- M6 mobile workspace update:
  - The sticky header wraps below `760px` so the title, workspace switch,
    settings button, shutdown button, and resource bar stay readable on narrow
    screens.
  - Mobile browser checks verified the Yanhe first screen, batch workspace, and
    settings drawer do not create horizontal page overflow.
  - This is a layout-only change and does not alter download, batch, extraction,
    or export behavior.
- M8 download regression update:
  - Download-job SSE now terminates cleanly when a UI subscribes after a job has
    already reached `completed`, `error`, or `cancelled`.
  - Tests cover terminal event delivery, late terminal subscribers, SSE cleanup,
    and the existing-MP4 path adding exactly one video to batch unselected
    without auto-starting extraction.
- M8 release packaging update:
  - Added `docs/yanhe-release-packaging.md` with the sidecar ffmpeg release
    checklist and no-commit rules.
  - Runtime resource discovery now checks Nuitka `__compiled__.containing_dir`
    as well as PyInstaller `_MEIPASS`, the app/exe directory, and source checkout.
  - README now has a v0.4.2 Yanhe batch quick flow and links to packaging notes.
- M8 runtime smoke update:
  - Restarted the local server on `http://127.0.0.1:5882` after backend changes.
  - `/api/diagnostics/status` reports bundled ffmpeg at
    `bin\ffmpeg.exe`, the getvideo development login profile, and F-drive
    downloads with ample free space.
  - Course `67968` loads as `生物仪器分析` with `16` recordings.
  - A single-session dry-run job for `863057` completed with progress `100`.
  - Late-terminal SSE via `curl` returned only the final init event and closed.
- M9 branch management update:
  - Pushed annotated tag `yanhe-v0.4.2-alpha.1`.
  - Created Draft PR `https://github.com/PWO-CHINA/VidSlide/pull/1` titled
    `Yanhe v0.4.2 batch branch - do not merge into main yet`.
- Post-alpha settings polish:
  - On narrow screens, the settings drawer now opens full-width with a sticky
    title bar.
  - The drawer explains ffmpeg, the F-drive download default, temporary getvideo
    profile reuse, and source cleanup in clearer language.
  - Browser smoke verified no horizontal overflow and no overflowing controls.
- Release-candidate build smoke:
  - Built `dist\VidSlide-yanhe-v0.4.2-alpha.1.exe` with PyInstaller and bundled
    `bin\ffmpeg.exe`.
  - The exe started on port `5883` with `--no-browser`.
  - Diagnostics reported bundled ffmpeg from the PyInstaller `_MEI...\bin\ffmpeg.exe`
    extraction path, F-drive downloads, and zero external asset references.
  - Root HTML, course load for `67968`, one-session dry-run, and terminal SSE
    smoke all passed.
- Third-party notice update:
  - Added `docs/THIRD_PARTY_NOTICES.md` for bundled FFmpeg.
  - The local Gyan.dev FFmpeg binary reports `--enable-gpl --enable-version3`;
    release notes should include FFmpeg source/legal links before publishing a
    bundled executable.
  - Since `yanhe-v0.4.2-alpha.1` was tagged before post-alpha polish, publish the
    next binary from a new `yanhe-v0.4.2-alpha.2` tag instead of attaching the
    current exe to alpha.1.
- Alpha 2 prerelease:
  - Pushed tag `yanhe-v0.4.2-alpha.2`.
  - Built and smoke-tested `dist\VidSlide-yanhe-v0.4.2-alpha.2.exe`.
  - Published prerelease:
    `https://github.com/PWO-CHINA/VidSlide/releases/tag/yanhe-v0.4.2-alpha.2`
  - Uploaded assets:
    `VidSlide-yanhe-v0.4.2-alpha.2.exe` and `THIRD_PARTY_NOTICES.md`.
  - GitHub asset digest for the exe:
    `sha256:dd21d1dff84522c1fcacbcf4a687e795855f42fb9f5f928671f9f920b92b0103`.
- Next immediate steps:
  - Commit and push the prerelease documentation.
  - Continue with real-user polish and decide whether to test one short real
    download from the published exe.
