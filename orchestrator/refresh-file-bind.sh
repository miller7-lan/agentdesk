#!/bin/sh
# Refresh only a file bind explicitly configured by the administrator in fstab.
set -eu
source_file=${1:?missing source}
target_file=${2:?missing target}
fail() { echo "$1" >&2; exit 1; }

[ "$source_file" != "$target_file" ] || fail 'Source and target must differ'
[ -f "$source_file" ] && [ ! -L "$source_file" ] || fail 'Bind source is unavailable'
[ -f "$target_file" ] && [ ! -L "$target_file" ] || fail 'Bind target is unavailable'
configured=$(findmnt --fstab -rn -M "$target_file" -o SOURCE)
[ "$configured" = "$source_file" ] || fail 'File bind does not match fstab'
options=$(findmnt --fstab -rn -M "$target_file" -o OPTIONS)
case ",$options," in *,bind,*) ;; *) fail 'Expected a bind entry in fstab' ;; esac

identity() { stat -Lc '%d:%i' -- "$1"; }
if findmnt -rn -M "$target_file" >/dev/null; then
  if [ "$(identity "$source_file")" = "$(identity "$target_file")" ]; then exit 0; fi
  # Never stack mounts or force a busy mount off. A later timer tick can retry.
  umount -- "$target_file"
fi
mount -- "$target_file"
[ "$(identity "$source_file")" = "$(identity "$target_file")" ] || fail 'Source changed again during refresh'
echo 'Refreshed configured file bind'
