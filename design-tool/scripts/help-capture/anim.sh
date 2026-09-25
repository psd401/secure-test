#!/bin/bash
# Help-page capture (docs/help-capture.md): retime and crop a multi-frame GIF
# exported by the Chrome recorder (~/Downloads/<raw>.gif) into
# public/help/<name>.gif — every frame shown <step> seconds, the last held 3 s,
# optional crop (w:h:x:y) and width (default 900), 128-colour palette.
#
#   scripts/help-capture/anim.sh monitor-raw monitor 0.9 1150:746:160:0
set -euo pipefail
raw="$1"; name="$2"; step="${3:-1.0}"; crop="${4:-}"; width="${5:-900}"
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ffmpeg -loglevel error -i "$HOME/Downloads/$raw.gif" -vsync 0 "$tmp/f%03d.png"
frames=("$tmp"/f*.png)
{
  for i in "${!frames[@]}"; do
    d="$step"; [ "$i" -eq $((${#frames[@]} - 1)) ] && d=3.0
    printf "file '%s'\nduration %s\n" "${frames[$i]}" "$d"
  done
  printf "file '%s'\n" "${frames[${#frames[@]}-1]}"
} > "$tmp/list.txt"
vf="scale=$width:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none"
[ -n "$crop" ] && vf="crop=$crop,$vf"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$tmp/list.txt" -vf "$vf" -loop 0 "$here/../../public/help/$name.gif"
rm -f "$HOME/Downloads/$raw.gif"
echo "public/help/$name.gif ${#frames[@]} frames $(wc -c < "$here/../../public/help/$name.gif") bytes"
