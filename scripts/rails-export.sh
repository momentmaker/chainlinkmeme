#!/usr/bin/env bash
# Dumps tags + meme→tag mappings from the live Rails app on Fly as JSON.
# The script runs inside the container, so DATABASE_URL never leaves the host.
# Output goes to stdout; redirect to a file, then feed into generate-tomls.ts.
#
# Usage:
#   ./scripts/rails-export.sh > /tmp/rails-dump.json
#   tsx scripts/generate-tomls.ts /tmp/rails-dump.json
#
set -euo pipefail

APP="${FLY_APP:-chainlinkmeme-api}"

fly ssh console -a "$APP" -C "bin/rails runner 'require \"json\"; STDOUT.puts({tags: Tag.order(:name).pluck(:name), memes: Meme.includes(:tags).order(:filename).map { |m| {filename: m.filename, animated: m.animated, width: m.width, height: m.height, likes: m.likes, tags: m.tags.pluck(:name)} }}.to_json)'"
