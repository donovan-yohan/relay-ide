#!/usr/bin/env sh
set -eu

rustc_path="$(rustup which rustc)"
toolchain_bin="$(dirname "$rustc_path")"
PATH="$toolchain_bin:$PATH" exec cargo "$@"
