#!/bin/sh
set -eu
mkdir -p /results/consumer/recording /results/consumer/stream
cp /suite/recording.go /results/consumer/recording/main.go
cp /suite/stream.go /results/consumer/stream/main.go
cd /results/consumer
go mod init reacon-sdk-ci
go mod edit -replace github.com/reacon-io/reacon-go=/sdk
go mod edit -require github.com/reacon-io/reacon-go@v0.0.0
go mod tidy
go run /suite/operations.go /sdk > operations.json
go run ./recording
REACON_TEST_URL="$REACON_STREAM_TEST_URL" go run ./stream
