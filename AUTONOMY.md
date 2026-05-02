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

1. Commit and push the settings picker milestone.
2. Polish batch zone guidance and export progress so the user always knows the
   next manual action.
3. Add more regression tests around download job SSE terminal events and
   duplicate-path batch insertion.
4. Continue real smoke tests with course `https://www.yanhekt.cn/course/67968`,
   using short local clips for extraction unless a full-course overnight run is
   intentionally useful.
5. Review packaging/build notes so sidecar ffmpeg is included in release
   artifacts without being committed to Git.

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
