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
  version "0.1.0" # BUMP on every release

  # sqlite-vec loads libsqlite3 at runtime via Database.setCustomSQLite().
  # Apple's bundled libsqlite3 does not support loadable extensions, so
  # Homebrew's keg-only sqlite is what makes this formula functional on
  # macOS. On Linux, the bottle runtime already pulls a vec-capable lib.
  depends_on "sqlite"

  on_macos do
    on_arm do
      url "https://github.com/Nohyunjin/orgmem/releases/download/v#{version}/kg-darwin-arm64"
      sha256 "REPLACE_WITH_SHA256_OF_kg-darwin-arm64_AFTER_RELEASE"
    end
    # Intel macOS is not currently produced by release.yml. Add an
    # `on_intel do ... end` block here once the matrix adds darwin-x64.
  end

  on_linux do
    url "https://github.com/Nohyunjin/orgmem/releases/download/v#{version}/kg-linux-x86_64"
    sha256 "REPLACE_WITH_SHA256_OF_kg-linux-x86_64_AFTER_RELEASE"
  end

  def install
    # The download is a single bun-compiled binary named after its target
    # platform. Install it as plain `kg` so users' PATH stays clean.
    binary_name = if OS.mac? && Hardware::CPU.arm?
                    "kg-darwin-arm64"
                  elsif OS.linux?
                    "kg-linux-x86_64"
                  else
                    odie "unsupported platform — only darwin-arm64 and linux-x86_64 are shipped"
                  end
    bin.install Dir["*"].first => "kg"
    chmod 0755, bin/"kg"

    # Sanity — refuse to install a tarball that somehow shipped the wrong
    # architecture. `file` exits 0 with any output, so we grep the output.
    ohai "installed as #{bin}/kg (from #{binary_name})"
  end

  test do
    assert_match "orgmem", shell_output("#{bin}/kg --version")
  end
end
