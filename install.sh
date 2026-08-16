#!/bin/sh
# Install lode-cli: the CLI tool, the omp startup hook, and lode-specific
# agent rules.
#
#   ./install.sh           install everything
#   ./install.sh cli       CLI only (symlink to ~/.local/bin/lode)
#   ./install.sh hook      hook only (to ~/.omp/agent/hooks/pre/)
#   ./install.sh check     verify what's installed
#
# Requires Bun (https://bun.sh) for running the .ts file directly.
# The omp hook requires oh-my-pi (https://omp.sh).

set -eu
cd "$(dirname "$0")"

BIN_DIR="${HOME}/.local/bin"
OMP_HOOK_DIR="${HOME}/.omp/agent/hooks/pre"

install_cli() {
	mkdir -p "$BIN_DIR"
	ln -sf "$(pwd)/lode.ts" "$BIN_DIR/lode"
	echo "installed $BIN_DIR/lode -> $(pwd)/lode.ts"
}

install_hook() {
	if [ ! -d "$OMP_HOOK_DIR" ]; then
		echo "omp hooks directory not found: $OMP_HOOK_DIR"
		echo "install oh-my-pi first, or set OMP_HOOK_DIR"
		exit 1
	fi
	ln -sf "$(pwd)/hooks/load-lode.ts" "$OMP_HOOK_DIR/load-lode.ts"
	echo "installed $OMP_HOOK_DIR/load-lode.ts -> $(pwd)/hooks/load-lode.ts"
}

check_all() {
	rc=0
	if [ -L "$BIN_DIR/lode" ]; then
		echo "ok   $BIN_DIR/lode"
	else
		echo "MISSING  $BIN_DIR/lode"
		rc=1
	fi
	if [ -L "$OMP_HOOK_DIR/load-lode.ts" ]; then
		echo "ok   $OMP_HOOK_DIR/load-lode.ts"
	else
		echo "MISSING  $OMP_HOOK_DIR/load-lode.ts"
		rc=1
	fi
	return $rc
}

TARGET="${1:-all}"

case "$TARGET" in
	all)
		install_cli
		install_hook
		;;
	cli) install_cli ;;
	hook) install_hook ;;
	check) check_all ;;
	*)
		echo "usage: $0 [all|cli|hook|check]"
		exit 2
		;;
esac