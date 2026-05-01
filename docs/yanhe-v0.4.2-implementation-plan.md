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
- M3/M4 backend integration is in progress:
  - `yanhe_downloader_core.py` copied/adapted from getvideo.
  - `yanhe_download_manager.py` added.
  - Yanhe login/course/download/import/diagnostics API routes added.
  - `py_compile` passed after these additions.
  - `/api/yanhe/login/status` verified usable with the existing getvideo profile.
- Next immediate steps:
  - Commit and push the Yanhe backend API milestone.
  - Wire frontend workspace controls to these APIs.
  - Add local vendor assets and remove CDN dependencies.
