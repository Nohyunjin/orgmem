# orgmem Homebrew Formula (draft)
#
# This file is the source-of-truth draft; the live copy ships in the
# external tap repository Nohyunjin/homebrew-tap at Formula/orgmem.rb.
# Workflow:
#   1. Cut a release via `git tag v<X.Y.Z> && git push --tags` — the
#      release.yml workflow builds kg-darwin-arm64 + kg-linux-x86_64 and
#      attaches them as GitHub Release assets.
#   2. Grab the sha256 of each binary from the release page (or compute
#      locally via `shasum -a 256 kg-<target>`).
#   3. Update `version`, the two `url`s, and the two `sha256`s below.
#   4. Copy this file to `Nohyunjin/homebrew-tap:Formula/orgmem.rb` and
#      push. End users then run: `brew install Nohyunjin/tap/orgmem`.
#
# Design notes:
#   - We ship the bun-compile single-file binary, not a source install.
#     The binary embeds the Bun runtime, so end users do NOT need Bun
#     or Node on PATH — much simpler install story than the npm path.
#   - We still depend_on "sqlite" because sqlite-vec loads libsqlite3
#     at runtime (no way around that without statically linking the ext,
#     which is a Phase 2 problem).
#   - `kg --version` is the test because it's the only CLI path that
#     doesn't touch the DB or the vec extension — so `brew test orgmem`
#     passes on any machine, including runners without a working
#     libsqlite3.

class Orgmem < Formula
  desc "Agent-native knowledge & work graph (MCP) — markdown vault → SQLite + sqlite-vec"
  homepage "https://github.com/Nohyunjin/orgmem"
  license "MIT"
  version "0.2.0" # BUMP on every release

  # sqlite-vec loads libsqlite3 at runtime via Database.setCustomSQLite().
  # Apple's bundled libsqlite3 does not support loadable extensions, so
  # Homebrew's keg-only sqlite is what makes this formula functional on
  # macOS. On Linux, the bottle runtime already pulls a vec-capable lib.
  depends_on "sqlite"

  on_macos do
    on_arm do
      url "https://github.com/Nohyunjin/orgmem/releases/download/v#{version}/kg-darwin-arm64"
      sha256 "2b6b5115bb20e23792264d82c456ab220fed44ea3b5ec0acb8b489c7283604b7"
    end
    # Intel macOS is not currently produced by release.yml. Add an
    # `on_intel do ... end` block here once the matrix adds darwin-x64.
  end

  on_linux do
    url "https://github.com/Nohyunjin/orgmem/releases/download/v#{version}/kg-linux-x86_64"
    sha256 "076cc92f1eefaafa09b707b16ed01ed8d0d6a34ab7f2a4405597cac9f26aa3ab"
  end

  def install
    # Each platform's `url` block above downloads exactly one file named
    # `kg-<target>` into the build dir. Install it as plain `kg` so the
    # caller's PATH stays clean.
    binary = Dir["kg-*"].first
    odie "no kg binary found in download (Dir entries: #{Dir["*"].inspect})" if binary.nil?
    bin.install binary => "kg"
    chmod 0755, bin/"kg"
  end

  test do
    assert_match "orgmem", shell_output("#{bin}/kg --version")
  end
end
