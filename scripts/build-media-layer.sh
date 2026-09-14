#!/usr/bin/env bash
set -euo pipefail

# Build a small, Linux x86_64-only decoder from the signed stable upstream source.
# Nothing from the project or its credentials is mounted into the builder.
task_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
task_output="${1:-$task_root/.local/media-layer}"
mkdir -p "$task_output"
docker run --rm --platform linux/amd64 --cpus 4 --memory 2g \
  -v "$task_output:/out" alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce sh -ec '
    apk add --no-cache build-base curl xz nasm gnupg > /out/dependencies.log 2>&1
    mkdir -p /build/gnupg
    chmod 700 /build/gnupg
    cd /build
    curl --fail --silent --show-error --proto =https --tlsv1.2 https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz -o source.tar.xz
    curl --fail --silent --show-error --proto =https --tlsv1.2 https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz.asc -o source.tar.xz.asc
    curl --fail --silent --show-error --proto =https --tlsv1.2 https://ffmpeg.org/ffmpeg-devel.asc -o release-key.asc
    gpg --homedir /build/gnupg --batch --import release-key.asc > /out/signature.log 2>&1
    gpg --homedir /build/gnupg --status-fd 1 --verify source.tar.xz.asc source.tar.xz > /out/signature-status.txt 2>> /out/signature.log
    awk '\''$2 == "VALIDSIG" && $3 == "FCF986EA15E6E293A5644F10B4322F04D67658D8" {valid=1} END {exit valid ? 0 : 1}'\'' /out/signature-status.txt
    sha256sum source.tar.xz > /out/source.sha256
    tar -xf source.tar.xz
    cd ffmpeg-9.0.1
    ./configure --prefix=/out --disable-everything --disable-doc --disable-debug \
      --disable-network --disable-autodetect --disable-shared --enable-static \
      --enable-small --disable-ffplay --extra-ldflags=-static \
      --enable-protocol=file,pipe --enable-demuxer=mov,image2 \
      --enable-decoder=h264,hevc,mjpeg --enable-parser=h264,hevc \
      --enable-encoder=mjpeg --enable-muxer=image2,image2pipe \
      --enable-filter=select,fps,scale,format,tile,setpts \
      > /out/configure.log 2>&1
    make -j4 ffmpeg ffprobe > /out/build.log 2>&1
    mkdir -p /out/bin /out/licenses
    cp ffmpeg ffprobe /out/bin/
    strip /out/bin/ffmpeg /out/bin/ffprobe
    cp COPYING.LGPLv2.1 LICENSE.md /out/licenses/
    /out/bin/ffmpeg -version > /out/version.txt
    /out/bin/ffmpeg -protocols > /out/protocols.txt 2>&1
    sha256sum /out/bin/ffmpeg /out/bin/ffprobe > /out/binaries.sha256
  '
docker image inspect alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce --format '{{json .RepoDigests}}' > "$task_output/builder-image.json"
printf 'Media decoder built in %s\n' "$task_output"
