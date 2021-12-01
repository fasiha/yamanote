#!/bin/sh
mkdir -p backups
tar czf backups/yamanote-$(date +%s).tar.gz .data/yamanote-v*.db*

