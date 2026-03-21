#!/bin/sh
set -e
node_modules/.bin/prisma migrate deploy
node_modules/.bin/prisma generate
exec "$@"
