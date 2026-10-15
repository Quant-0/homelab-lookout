#!/bin/sh
# Makes docs/guide/img/demo.gif, the README's animated tour, from the frames docs/guide/demo.js
# recorded (the example lab on port 18080). Uses ffmpeg and gifsicle from container images, so
# nothing has to be installed; ENGINE=docker or podman (default).
#
#   node docs/guide/demo.js /tmp/demo && sh docs/guide/demo-gif.sh /tmp/demo
set -eu
DIR=${1:-/tmp/demo}
ENGINE=${ENGINE:-podman}
OUT=$(cd "$(dirname "$0")" && pwd)/img/demo.gif
# 1.5x faster, 12 frames a second, 960 px wide, its own palette
"$ENGINE" run --rm -v "$DIR:/w:Z" -w /w docker.io/mwader/static-ffmpeg:7.1 -loglevel error -y \
  -f concat -safe 0 -i frames.ffconcat \
  -filter_complex "setpts=PTS/1.5,fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 demo-full.gif
# about half the size, no visible difference
"$ENGINE" run --rm -v "$DIR:/w:Z" docker.io/library/alpine:3.22 sh -c "apk add -q gifsicle >/dev/null && gifsicle -O3 --lossy=30 /w/demo-full.gif -o /w/demo.gif"
cp "$DIR/demo.gif" "$OUT"
echo "$OUT: $(wc -c < "$OUT") bytes"
