#!/bin/sh
# Builds the DOOM engine helper for every platform the plugin ships, into ../bin/<platform>/.
#
#   ./build.sh            every platform (needs zig: `pip install ziglang`)
#   ./build.sh native     this machine only, with the system's cc
set -e
cd "$(dirname "$0")"

SRC="dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net f_finale f_wipe
g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv m_bbox
m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy p_floor p_inter p_lights
p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp
r_data r_draw r_main r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video
wi_stuff w_checksum w_file w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric"

FILES="doomgeneric_claude.c"
for name in $SRC; do FILES="$FILES doomgeneric/$name.c"; done

FLAGS="-O2 -s -w -std=gnu99 -Idoomgeneric -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 -D_DEFAULT_SOURCE"

build() { # <platform> <compiler...>
  platform=$1; shift
  out=../bin/$platform/clawd-doom
  case $platform in win32-*) out=$out.exe ;; esac
  mkdir -p "../bin/$platform"
  echo "building $platform"
  "$@" $FLAGS $FILES -o "$out" -lm
}

if [ "$1" = native ]; then
  build "$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" cc -DNORMALUNIX -DLINUX
  exit
fi

ZIG="python3 -m ziglang"
build linux-x64 $ZIG cc -target x86_64-linux-musl -static -DNORMALUNIX -DLINUX
build linux-arm64 $ZIG cc -target aarch64-linux-musl -static -DNORMALUNIX -DLINUX
build darwin-x64 $ZIG cc -target x86_64-macos -DNORMALUNIX
build darwin-arm64 $ZIG cc -target aarch64-macos -DNORMALUNIX
build win32-x64 $ZIG cc -target x86_64-windows-gnu
