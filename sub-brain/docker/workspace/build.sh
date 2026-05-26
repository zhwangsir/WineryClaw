#!/usr/bin/env bash
# Build the webrain-workspace Docker image used by DockerSandbox workspace
# mode (Round J2). Idempotent — safe to rerun.
#
# Usage:
#   ./sub-brain/docker/workspace/build.sh           # default tag :latest
#   IMAGE_TAG=dev ./sub-brain/docker/workspace/build.sh
#
# Requires Docker on PATH. Exits 1 with a friendly message if it isn't.

set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-webrain-workspace}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_TAG="${IMAGE_NAME}:${IMAGE_TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "[build-workspace-image] docker not found on PATH — install Docker Desktop first." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[build-workspace-image] Docker daemon not running — start Docker Desktop first." >&2
  exit 1
fi

echo "[build-workspace-image] Building ${FULL_TAG} from ${SCRIPT_DIR}/Dockerfile"
docker build \
  --tag "${FULL_TAG}" \
  --label "org.webrain.role=sandbox-workspace" \
  --label "org.webrain.round=J2" \
  --file "${SCRIPT_DIR}/Dockerfile" \
  "${SCRIPT_DIR}"

echo "[build-workspace-image] Built ${FULL_TAG}"
docker image inspect "${FULL_TAG}" --format '  size: {{.Size}} bytes ({{len .RootFS.Layers}} layers)'
