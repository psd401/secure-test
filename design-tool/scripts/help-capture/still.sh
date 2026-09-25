#!/bin/bash
# Help-page capture (docs/help-capture.md): turn a one-frame GIF exported by
# the Chrome recorder (~/Downloads/<name>.gif) into public/help/<name>.png —
# optional crop (w:h:x:y in viewport pixels), 256-colour palette, download removed.
#
#   scripts/help-capture/still.sh results 1010:694:228:52
set -euo pipefail
name="$1"; crop="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
src="$HOME/Downloads/$name.gif"
out="$here/../../public/help/$name.png"
vf="split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none"
[ -n "$crop" ] && vf="crop=$crop,$vf"
ffmpeg -loglevel error -y -i "$src" -frames:v 1 -vf "$vf" "$out"
rm -f "$src"
echo "$out $(wc -c < "$out") bytes"
