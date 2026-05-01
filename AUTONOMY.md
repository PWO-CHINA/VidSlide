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

1. Make F: the active download location.
2. Make ffmpeg available as a local sidecar and validated at runtime.
3. Run a real download smoke test with course `https://www.yanhekt.cn/course/67968`.
4. Verify downloaded video enters batch unselected zone and does not auto-start extraction.
5. Productize the UI using early task-doc guidance: clear flow, human parameter
   explanations, actionable errors, storage/ffmpeg clarity.
