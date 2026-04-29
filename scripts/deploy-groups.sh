#!/usr/bin/env bash
#
# Pull latest origin/<default-branch> into each group's workspace.
#
# Closes the deploy gap where merging a PR into a group's workspace remote
# (e.g. ligolnik/lombot) doesn't propagate to the running container, because
# nothing on the host pulls origin into groups/<name>/. The container itself
# can't pull (HTTP-Basic auth gap), so this lives host-side where the auth is.
#
# Behavior per group:
#   - Skip if not a git repo.
#   - Skip if HEAD isn't on the default branch (agent may be on a feature branch).
#   - git fetch origin <branch>, then merge --ff-only.
#   - Non-fast-forward is a visible failure (local diverged from origin) — needs
#     human resolution; the script does NOT reset --hard, since that would nuke
#     unpushed agent commits.
#   - Record the deployed SHA to data/deploy-state/<group>.sha so a heartbeat
#     monitor can detect stale workspaces.
#
# Wire via cron on the host that owns groups/ (every 5 min):
#   */5 * * * * cd /path/to/nanoclaw && ./scripts/deploy-groups.sh >> data/logs/deploy-groups.log 2>&1
#
# Override default branch with DEFAULT_BRANCH env var (defaults to "main").
# Limit to specific groups with positional args: ./deploy-groups.sh lombot foo

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
GROUPS_DIR="$PROJECT_ROOT/groups"
STATE_DIR="$PROJECT_ROOT/data/deploy-state"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

log() { echo "[deploy-groups] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if [ ! -d "$GROUPS_DIR" ]; then
  log "ERROR: groups dir not found at $GROUPS_DIR"
  exit 1
fi

mkdir -p "$STATE_DIR"

FILTER=("$@")
in_filter() {
  [ "${#FILTER[@]}" -eq 0 ] && return 0
  for g in "${FILTER[@]}"; do
    [ "$g" = "$1" ] && return 0
  done
  return 1
}

UPDATED=0
UP_TO_DATE=0
SKIPPED_NOGIT=0
SKIPPED_BRANCH=0
FAILED=0

for group_dir in "$GROUPS_DIR"/*/; do
  [ -d "$group_dir" ] || continue
  group_name="$(basename "$group_dir")"

  in_filter "$group_name" || continue

  if [ ! -d "$group_dir/.git" ]; then
    SKIPPED_NOGIT=$((SKIPPED_NOGIT + 1))
    continue
  fi

  current_branch=$(git -C "$group_dir" rev-parse --abbrev-ref HEAD)
  if [ "$current_branch" != "$DEFAULT_BRANCH" ]; then
    log "[$group_name] on '$current_branch' (not $DEFAULT_BRANCH) — skipping"
    SKIPPED_BRANCH=$((SKIPPED_BRANCH + 1))
    continue
  fi

  before_sha=$(git -C "$group_dir" rev-parse HEAD)

  if ! git -C "$group_dir" fetch --quiet origin "$DEFAULT_BRANCH"; then
    log "[$group_name] FETCH FAILED"
    FAILED=$((FAILED + 1))
    continue
  fi

  remote_sha=$(git -C "$group_dir" rev-parse "origin/$DEFAULT_BRANCH")
  state_file="$STATE_DIR/$group_name.sha"

  if [ "$before_sha" = "$remote_sha" ]; then
    UP_TO_DATE=$((UP_TO_DATE + 1))
    echo "$before_sha" > "$state_file"
    touch "$state_file"
    continue
  fi

  if ! git -C "$group_dir" merge --ff-only "origin/$DEFAULT_BRANCH"; then
    log "[$group_name] NOT FAST-FORWARD: $before_sha ↛ $remote_sha (manual resolution needed)"
    FAILED=$((FAILED + 1))
    continue
  fi

  after_sha=$(git -C "$group_dir" rev-parse HEAD)
  echo "$after_sha" > "$state_file"
  log "[$group_name] $before_sha → $after_sha"
  UPDATED=$((UPDATED + 1))
done

log "summary: updated=$UPDATED up-to-date=$UP_TO_DATE skipped-nogit=$SKIPPED_NOGIT skipped-branch=$SKIPPED_BRANCH failed=$FAILED"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
