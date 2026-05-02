# Third-Party Notices

This branch can produce a Windows executable that bundles a local `ffmpeg.exe`
sidecar for Yanhe recording downloads.

## FFmpeg

- Component: FFmpeg command-line executable
- Local path used for alpha builds: `bin\ffmpeg.exe`
- Local build string: `ffmpeg version 2025-11-10-git-133a0bcb13-full_build-www.gyan.dev`
- Build provider: Gyan.dev Windows build
- Upstream project: https://ffmpeg.org/
- Official legal page: https://ffmpeg.org/legal.html
- Official source download page: https://ffmpeg.org/download.html
- Gyan.dev Windows builds page: https://www.gyan.dev/ffmpeg/builds/

The local binary reports `--enable-gpl --enable-version3` in its configuration.
Treat the bundled FFmpeg binary as GPLv3-or-later licensed unless a different
replacement binary is supplied and verified.

VidSlide source code remains under this repository's license. FFmpeg is a
separate third-party executable. Releases that bundle FFmpeg should keep this
notice visible in the release notes and provide the source/legal links above.
