#!/usr/bin/env ruby
# frozen_string_literal: true

# =============================================================
# AppTheory · docs version override generator
#
# Writes docs/_config_versions.yml — a Jekyll config override that stamps the
# docs site with a real release tag. .github/workflows/pages.yml resolves the
# release tag (release event payload, or the latest published non-prerelease
# tag for workflow_dispatch), calls this script, and builds with
# `--config _config.yml,_config_versions.yml`, so the site's version pill and
# runtime install commands always match the latest published release instead of
# the hand-maintained pins in docs/_config.yml (`version_pill: "v1.x"`,
# `v3.0.0-rc` / `v1.14.0` install pins).
#
# INTENTIONAL DIFFERENCE from the sibling frameworks (TableTheory PR #562,
# FaceTheory PR #452, same wave): those frameworks' docs/_config.yml carries
# `vX.Y.Z` PLACEHOLDER install URLs and the script does a literal
# `gsub("vX.Y.Z", tag).gsub("X.Y.Z", bare)`. AppTheory's docs/_config.yml
# carries REAL pinned versions, so this script keeps REGEX stamping instead.
#
# Jekyll config merging (`jekyll build --config a,b`) deep-merges hashes but
# REPLACES arrays wholesale — the override therefore carries the COMPLETE
# tabletheory.runtimes array from docs/_config.yml, with every version inside
# each install string replaced by the tag (asset filenames strip the leading
# `v`). The landing page (docs/index.html) renders each install command from
# site.tabletheory.runtimes (by-id lookup) with a `| default: r.install`
# fallback to docs/_data/runtimes.yml, so the override's runtimes array is
# load-bearing instead of dead weight. docs/_config.yml itself is never
# modified and remains the local-preview fallback; docs/_config_versions.yml is
# a CI/local-gate generated artifact and is git-ignored.
#
# Regex-stamping ORDER is load-bearing (LOW-1 regression): the BARE `X.Y.Z`
# pass runs FIRST and the `v`-prefixed pass SECOND. The bare pass's `(?<!v)`
# lookbehind skips `vX.Y.Z` tag references — the digit after `v` is guarded and
# no partial `X.Y.Z` match can start inside them — so with a >=2-digit major
# tag (e.g. v10.2.3) the bare pass can never re-match inside the v-prefixed
# stamp and produce `v110.2.3`. Filenames like
# theory-cloud-apptheory-1.14.0.tgz stamp bare; the v-pass then stamps every
# `vX.Y.Z` token (e.g. `download v1.14.0`) and drops any pre-release suffix
# (`v3.0.0-rc` → the tag verbatim).
#
# The override is generated only from the release tag — no secrets, no
# branch-state input.
# =============================================================

require "optparse"
require "yaml"

DEFAULT_CONFIG = "docs/_config.yml"
DEFAULT_OUTPUT = "docs/_config_versions.yml"

# Replace every version occurrence in an install string with the release tag:
# `vX.Y.Z` tag references become the tag verbatim, bare `X.Y.Z` tokens (asset
# filenames) become the tag without the leading `v`. Order is load-bearing —
# bare pass first, v-prefixed pass second (see header).
def stamp_install(install, tag, bare)
  bare_tag_re = /(?<!v)[0-9]+\.[0-9]+\.[0-9]+/
  v_tag_re = /v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?/
  install.gsub(bare_tag_re) { bare }.gsub(v_tag_re) { tag }
end

def main(argv)
  options = {}
  OptionParser.new do |opts|
    opts.banner = "Usage: #{$PROGRAM_NAME} --tag TAG [--config PATH] [--output PATH]"
    opts.on("--config PATH", "Source Jekyll config (default: #{DEFAULT_CONFIG})") do |path|
      options[:config] = path
    end
    opts.on("--tag TAG", "Release tag to stamp (e.g. v3.3.0)") do |tag|
      options[:tag] = tag
    end
    opts.on("--output PATH", "Output override path (default: #{DEFAULT_OUTPUT})") do |path|
      options[:output] = path
    end
  end.parse!(argv)

  config_path = options[:config] || DEFAULT_CONFIG
  tag = options[:tag]
  output_path = options[:output] || DEFAULT_OUTPUT

  abort "error: --tag is required (e.g. v3.3.0)" if tag.nil? || tag.empty?
  abort "error: config not found: #{config_path}" unless File.file?(config_path)

  config = YAML.safe_load(File.read(config_path))
  runtimes = config.dig("tabletheory", "runtimes")
  abort "error: #{config_path} has no tabletheory.runtimes array" unless runtimes.is_a?(Array)

  bare = tag.start_with?("v") ? tag[1..] : tag

  stamped = runtimes.map do |runtime|
    runtime = runtime.dup
    install = runtime["install"]
    runtime["install"] = stamp_install(install, tag, bare) if install.is_a?(String)
    runtime
  end

  override = { "tabletheory" => { "version_pill" => tag, "runtimes" => stamped } }

  File.write(output_path, YAML.dump(override, line_width: -1))
  puts "wrote #{output_path} (version_pill=#{tag}, #{stamped.length} runtime(s))"
end

main(ARGV)
