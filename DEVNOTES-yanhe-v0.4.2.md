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
