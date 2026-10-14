#!/bin/sh
# VARA installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/VARA-TEAM/vara-cli/main/install.sh | sh
#
# Options (environment variables):
#   VARA_VERSION=v0.1.0       install a specific release (default: latest)
#   VARA_REPO=owner/repo      install from a fork
#   VARA_INSTALL_DIR=...      where to unpack (default: ~/.local/share/vara)
#   VARA_BIN_DIR=...          where to put the `vara` link (default: ~/.local/bin)
#
# No sudo, nothing else to install: the download includes its own Node.js runtime.
# If the repository is private, sign in once with the GitHub CLI (gh auth login) and
# this script will use it automatically.
set -eu

REPO="${VARA_REPO:-VARA-TEAM/vara-cli}"
VERSION="${VARA_VERSION:-latest}"
INSTALL_DIR="${VARA_INSTALL_DIR:-$HOME/.local/share/vara}"
BIN_DIR="${VARA_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)  os=linux ;;
  Darwin) os=macos ;;
  *) die "unsupported system '$os'. On Windows use install.ps1." ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported CPU '$arch'." ;;
esac
asset="vara-$os-$arch.tar.gz"
case "$os-$arch" in
  linux-x64|macos-arm64) ;;
  *) die "there is no prebuilt VARA for $os-$arch yet (available: linux-x64, macos-arm64, win-x64). Open an issue at https://github.com/$REPO/issues" ;;
esac

command -v tar >/dev/null 2>&1 || die "tar is required."
tmp="$(mktemp -d 2>/dev/null || mktemp -d -t vara)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading VARA ($VERSION) for $os-$arch..."
got=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if [ "$VERSION" = latest ]; then
    gh release download -R "$REPO" -p "$asset" -p SHA256SUMS.txt -D "$tmp" --clobber >/dev/null 2>&1 && got=1 || got=0
  else
    gh release download "$VERSION" -R "$REPO" -p "$asset" -p SHA256SUMS.txt -D "$tmp" --clobber >/dev/null 2>&1 && got=1 || got=0
  fi
fi
if [ "$got" = 0 ]; then
  if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"; else base="https://github.com/$REPO/releases/download/$VERSION"; fi
  command -v curl >/dev/null 2>&1 || die "curl is required."
  curl -fsSL "$base/$asset" -o "$tmp/$asset" || die "could not download the release. If the repository is private, run 'gh auth login' first and try again."
  curl -fsSL "$base/SHA256SUMS.txt" -o "$tmp/SHA256SUMS.txt" || die "could not download SHA256SUMS.txt"
fi

# Verify the download before unpacking anything.
expected="$(grep " $asset\$" "$tmp/SHA256SUMS.txt" | awk '{print $1}' | head -n 1)"
[ -n "$expected" ] || die "SHA256SUMS.txt does not list $asset - refusing to install."
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
else die "need sha256sum or shasum to verify the download."; fi
[ "$expected" = "$actual" ] || die "checksum mismatch (expected $expected, got $actual) - refusing to install."

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
rm -rf "$INSTALL_DIR/vara.new"
mkdir -p "$INSTALL_DIR/vara.new"
tar -xzf "$tmp/$asset" -C "$INSTALL_DIR/vara.new"
[ -x "$INSTALL_DIR/vara.new/vara/vara" ] || die "the archive did not contain VARA - installation failed."
rm -rf "$INSTALL_DIR/vara"
mv "$INSTALL_DIR/vara.new/vara" "$INSTALL_DIR/vara"
rmdir "$INSTALL_DIR/vara.new" 2>/dev/null || true
ln -sf "$INSTALL_DIR/vara/vara" "$BIN_DIR/vara"

say ""
say "VARA $("$BIN_DIR/vara" --version) is installed: $BIN_DIR/vara"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
say ""
say "Next:"
say "  vara setup    connect a provider and pick a model"
say "  vara          start"
say "  vara doctor   check that everything works"
