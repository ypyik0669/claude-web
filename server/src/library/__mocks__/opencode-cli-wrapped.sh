#!/bin/sh
# POSIX counterpart of opencode-cli-wrapped.cmd: no `exec`, so the tree is sh -> node -> grandchild and
# only a tree kill takes the node process (and whatever it started) down with the launcher
node "$(dirname "$0")/opencode-cli.mjs" "$@"
