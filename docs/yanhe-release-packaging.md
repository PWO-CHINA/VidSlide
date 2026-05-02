# Yanhe v0.4.2 Release Packaging Notes

This branch can ship with a local ffmpeg sidecar, but ffmpeg binaries must stay
out of Git history.

## Expected Local Layout

For development and release preparation:

```text
VidSlide-v0.4.2-yanhe-batch/
  app.py
  bin/
    ffmpeg.exe
```

`bin\ffmpeg.exe` is ignored by `.gitignore`. The current local sidecar is a
Gyan.dev full build and reports GPL-enabled configuration, so any public release
that bundles it should include the matching ffmpeg license/source notice.

## Build Scripts

Both Windows build scripts detect `bin\ffmpeg.exe` automatically:

- `build.bat` adds it to PyInstaller output with `--add-binary`.
- `build_nuitka.bat` adds it to Nuitka output with `--include-data-file`.

The runtime search order prefers:

1. User-configured ffmpeg path, if valid.
2. Packaged resource directories such as PyInstaller `_MEIPASS` or Nuitka
   `__compiled__.containing_dir`.
3. The app/exe directory.
4. Source checkout directory.
5. `PATH`.
6. Read-only getvideo reference candidates.

## Pre-Release Checklist

Run from the branch root:

```powershell
bin\ffmpeg.exe -version
python -m unittest discover -s tests
python -m py_compile storage.py settings_store.py yanhe_downloader_core.py yanhe_download_manager.py app.py batch_manager.py extractor.py exporter.py
node --check static\js\main.js; node --check static\js\batch\core.js; node --check static\js\batch\export.js; node --check static\js\settings.js; node --check static\js\yanhe.js
rg -n "https://cdn|cdn\.jsdelivr|cdn\.tailwindcss|tailwindcss\.js" templates static --glob "!static/vendor/**"
git status --short
```

Then build one candidate:

```powershell
.\build_nuitka.bat
```

or:

```powershell
.\build.bat
```

After building, run the generated exe and verify:

- `/api/diagnostics/status` reports ffmpeg available from a bundled/app source.
- Course `https://www.yanhekt.cn/course/67968` loads with the expected 16
  recordings when login is available.
- A dry-run download works without writing video.
- A short real/existing download enters batch `unselected` and does not start
  extraction automatically.

## Do Not Commit

- `bin\ffmpeg.exe`
- `downloads/`, `imports/`, `sessions/`, `chrome-profile/`, `logs/`
- Generated `dist/`, `build/`, `.spec`, MP4/MKV/MOV/AVI/WebM files
- Yanhe tokens, signed URLs, profile databases, or screenshots containing
  account information
