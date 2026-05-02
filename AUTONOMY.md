# Autonomous Work Loop

The user is away and explicitly asked the agent to keep working without waiting
for replies.

## Active Objective

Ship VidSlide `yanhe/v0.4.2-batch` into a usable local product for Yanhe course
recording download, batch extraction, preview, and export.

## Loop

Repeat until the product is materially better:

1. Design: choose the smallest user-visible improvement that increases actual
   usability or reliability.
2. Build: implement it in the current branch only.
3. Test: run automated checks and, when relevant, real browser/API smoke tests.
4. Learn: write durable notes to `docs/yanhe-v0.4.2-implementation-plan.md`,
   `DEVNOTES-yanhe-v0.4.2.md`, or this file.
5. Commit and push when a milestone is stable.

## Standing Constraints

- Do not change the PPT extraction principle/algorithm unless a test shows a bug.
- Keep this branch focused on Yanhe classroom screen recordings.
- Do not modify `D:\the lab for html\getvideo`; it is a read-only source.
- Use F: for large downloads and smoke-test artifacts.
- Never save passwords, tokens, signed URLs, or Chrome profile contents to Git.
- Do not commit `ffmpeg.exe`; keep it as a local sidecar or release asset.
- Prefer recoverable changes and keep git milestones small.

## Current Priority Queue

1. Commit and push the FFmpeg notice update.
2. Tag `yanhe-v0.4.2-alpha.2`, rebuild the exe with the matching name, smoke it,
   and publish it as a prerelease asset if the smoke passes.
3. Continue real smoke tests with course `https://www.yanhekt.cn/course/67968`,
   using short local clips for extraction unless a full-course overnight run is
   intentionally useful.
4. Continue settings drawer visual polish and narrow-screen QA.
5. Keep the dev server on `http://127.0.0.1:5882` unless a port conflict appears.

## Latest Verified Loop

- `F:\VidSlide\yanhe-batch-v0.4.2\downloads` is the active download directory.
- `bin\ffmpeg.exe` is the active sidecar ffmpeg and is intentionally ignored by Git.
- Course `67968` loads, returns 16 recordings, and session `853828` downloads/exists correctly.
- Downloaded videos enter batch unselected zone only; extraction does not auto-start.
- Repeated download of the same existing MP4 no longer duplicates the batch entry.
- A 5-minute clip from the real Yanhe download extracted 4 slides in about 12 seconds.
- ZIP/PDF/PPTX export downloads for that sample returned HTTP 200.
- Settings now has native "选择" buttons for ffmpeg and download directory; tests
  mock the dialogs to avoid unattended hangs.
- Batch workspace now shows a three-step unselected -> queue -> completed/export
  guide and better export progress status.
- Soft resource warnings remain visible, but hard blocking now requires extreme
  pressure. A 30-second Yanhe sample batch run completed successfully.
- Mobile header/resource layout now wraps on narrow screens. Yanhe, batch, and
  settings drawer browser checks reported no horizontal overflow.
- Download-job SSE now closes cleanly for late terminal subscribers, and tests
  cover terminal events plus the existing-MP4 duplicate-download path.
- Release packaging notes document the local `bin\ffmpeg.exe` sidecar strategy.
  Runtime resource discovery now checks Nuitka's onefile containing directory.
- The current server was restarted on port `5882`; course `67968` loaded, a
  dry-run job completed, and late-terminal SSE closed immediately via `curl`.
- Draft PR `https://github.com/PWO-CHINA/VidSlide/pull/1` and tag
  `yanhe-v0.4.2-alpha.1` are both pushed.
- Post-alpha settings drawer polish passed mobile browser smoke: full-width
  drawer, sticky title bar, clearer ffmpeg/F-drive/getvideo-profile copy, and no
  horizontal overflow.
- Local PyInstaller exe candidate `dist\VidSlide-yanhe-v0.4.2-alpha.1.exe`
  was built and passed root-page, diagnostics, course-load, dry-run, and terminal
  SSE smoke on port `5883`.
- Do not attach the alpha.1 exe to the alpha.1 tag: that tag was created before
  later polish commits. Use alpha.2 for the first published binary asset.
