# Homebrew tap packaging

orgmem ships via an external Homebrew tap — `Nohyunjin/homebrew-tap` — so
end users install with:

```bash
brew install Nohyunjin/tap/orgmem
```

## Files in this directory

- `orgmem.rb` — the Formula, draft copy. The tap repo's
  `Formula/orgmem.rb` must match this file byte-for-byte except for the
  `version`, two `url`s, and two `sha256`s which get filled in per
  release.

## Release workflow (operator, ~5 minutes per release)

1. **Cut the tag in this repo.**
   ```bash
   git tag v0.1.0
   git push --tags
   ```
   `.github/workflows/release.yml` builds `kg-darwin-arm64` +
   `kg-linux-x86_64` and attaches them to the GitHub Release under the
   tag.

2. **Compute sha256 for each binary.**
   Option A — from the release page, open each asset and the browser
   shows the "Digests" (sha256). Option B — download + shasum locally:
   ```bash
   curl -LO https://github.com/Nohyunjin/orgmem/releases/download/v0.1.0/kg-darwin-arm64
   curl -LO https://github.com/Nohyunjin/orgmem/releases/download/v0.1.0/kg-linux-x86_64
   shasum -a 256 kg-darwin-arm64 kg-linux-x86_64
   ```

3. **Update this draft.**
   Bump `version` and paste the two sha256s over the
   `REPLACE_WITH_SHA256_OF_*` placeholders in `orgmem.rb`.

4. **Sync to the tap repo.**
   ```bash
   cp orgmem.rb ../../../homebrew-tap/Formula/orgmem.rb
   cd ../../../homebrew-tap
   git commit -am "orgmem 0.1.0"
   git push
   ```

5. **Verify.**
   ```bash
   brew tap Nohyunjin/tap
   brew install Nohyunjin/tap/orgmem
   kg --version
   brew audit --strict Nohyunjin/tap/orgmem   # optional, catches mistakes
   ```

## Why a single binary and not `npm install`?

The bun-compile binary embeds the Bun runtime, so the brew install works
on machines without Bun or Node at all. Dependency graph shrinks to just
`sqlite` (which sqlite-vec dlopens at runtime). Users who prefer the npm
path can still run `npm install -g orgmem` — that route is documented in
the main README.
