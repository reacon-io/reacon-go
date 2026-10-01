#!/bin/sh
set -eu
mkdir -p /results/consumer/recording /results/consumer/stream
cp /suite/recording.go /results/consumer/recording/main.go
cp /suite/stream.go /results/consumer/stream/main.go
cd /results/consumer
go mod init reacon-sdk-ci
sdk_module=$(awk '$1 == "module" { print $2 }' /sdk/go.mod)
sdk_major=${sdk_module##*/v}
case "$sdk_module" in */v[0-9]*) sdk_version="v$sdk_major.0.0" ;; *) sdk_version=v0.0.0 ;; esac
sed -i "s|github.com/reacon-io/reacon-go\"|$sdk_module\"|g" recording/main.go stream/main.go
go mod edit -replace "$sdk_module=/sdk"
go mod edit -require "$sdk_module@$sdk_version"
go mod tidy
go run /suite/operations.go /sdk > operations.json
go run ./recording
REACON_TEST_URL="$REACON_STREAM_TEST_URL" go run ./stream
