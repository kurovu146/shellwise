#!/usr/bin/env bash
# Render the Homebrew formula for the current release and push it to the tap repo.
# Requires release/shellwise-*.tar.gz to exist (run build-release.sh first) and
# `gh` authenticated with write access to the tap repo.
#
# Env:
#   TAG    git tag, e.g. v0.3.2   (required)
#   REPO   owner/name of this repo (default: kurovu146/shellwise)
#   TAP    owner/name of the tap repo (default: kurovu146/homebrew-tap)
#   DRY    if set, print the formula and skip the push
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${TAG:?set TAG, e.g. TAG=v0.3.2}"
REPO="${REPO:-kurovu146/shellwise}"
TAP="${TAP:-kurovu146/homebrew-tap}"
VERSION="${TAG#v}"

sha256_of() { shasum -a 256 "release/shellwise-$1.tar.gz" | cut -d' ' -f1; }
SHA_DARWIN_ARM64=$(sha256_of darwin-arm64)
SHA_DARWIN_X64=$(sha256_of darwin-x64)
SHA_LINUX_ARM64=$(sha256_of linux-arm64)
SHA_LINUX_X64=$(sha256_of linux-x64)

base="https://github.com/${REPO}/releases/download/${TAG}"

formula=$(cat <<RUBY
class Shellwise < Formula
  desc "Smart command history with inline auto-suggest and fuzzy search for your terminal"
  homepage "https://github.com/${REPO}"
  version "${VERSION}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${base}/shellwise-darwin-arm64.tar.gz"
      sha256 "${SHA_DARWIN_ARM64}"

      def install
        bin.install "shellwise-darwin-arm64" => "shellwise"
        bin.install_symlink "shellwise" => "sw"
      end
    else
      url "${base}/shellwise-darwin-x64.tar.gz"
      sha256 "${SHA_DARWIN_X64}"

      def install
        bin.install "shellwise-darwin-x64" => "shellwise"
        bin.install_symlink "shellwise" => "sw"
      end
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${base}/shellwise-linux-arm64.tar.gz"
      sha256 "${SHA_LINUX_ARM64}"

      def install
        bin.install "shellwise-linux-arm64" => "shellwise"
        bin.install_symlink "shellwise" => "sw"
      end
    else
      url "${base}/shellwise-linux-x64.tar.gz"
      sha256 "${SHA_LINUX_X64}"

      def install
        bin.install "shellwise-linux-x64" => "shellwise"
        bin.install_symlink "shellwise" => "sw"
      end
    end
  end

  def caveats
    <<~EOS
      Add shell integration to your config:

        # Zsh (~/.zshrc)
        eval "\\\$(shellwise init zsh)"

        # Bash (~/.bashrc)
        eval "\\\$(shellwise init bash)"

      Then restart your terminal or run: source ~/.zshrc
    EOS
  end

  test do
    assert_match "shellwise", shell_output("#{bin}/shellwise --help")
  end
end
RUBY
)

if [ -n "${DRY:-}" ]; then
  printf '%s\n' "$formula"
  exit 0
fi

blob=$(gh api "repos/${TAP}/contents/Formula/shellwise.rb" --jq .sha)
gh api -X PUT "repos/${TAP}/contents/Formula/shellwise.rb" \
  -f message="chore: shellwise ${VERSION}" \
  -f content="$(printf '%s\n' "$formula" | base64 | tr -d "\n")" \
  -f sha="$blob"

echo "✓ tap formula updated to ${VERSION}"
