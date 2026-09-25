# Local and CI dependency only. Sources are the signed upstream release commits.
FROM golang:1.24.2-alpine3.21@sha256:7772cb5322baa875edd74705556d08f0eeca7b9c4b5367754ce3f2f00041ccee AS minio-build
WORKDIR /src/minio
ADD --checksum=sha256:7eb30a913fea30f18069abf194e1e78e4983b558cc526911ae1c11396a9859a5 https://codeload.github.com/minio/minio/tar.gz/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e /tmp/minio.tar.gz
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1 && \
    mkdir -p /out && \
    CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -tags kqueue -trimpath \
      -ldflags='-s -w -X github.com/minio/minio/cmd.Version=2025-04-22T22:12:26Z -X github.com/minio/minio/cmd.CopyrightYear=2025 -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-04-22T22-12-26Z -X github.com/minio/minio/cmd.CommitID=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e -X github.com/minio/minio/cmd.ShortCommitID=0d7408fc9969' \
      -o /out/minio . && \
    GOTOOLCHAIN=local go mod verify

FROM golang:1.24.2-alpine3.21@sha256:7772cb5322baa875edd74705556d08f0eeca7b9c4b5367754ce3f2f00041ccee AS mc-build
WORKDIR /src/mc
ADD --checksum=sha256:4cd13e34daeeb8481c3ba8686b082f161b8dc1f7aad52d715a706a587349c6ae https://codeload.github.com/minio/mc/tar.gz/b00526b153a31b36767991a4f5ce2cced435ee8e /tmp/mc.tar.gz
RUN tar -xzf /tmp/mc.tar.gz --strip-components=1 && \
    mkdir -p /out && \
    CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -tags kqueue -trimpath \
      -ldflags='-s -w -X github.com/minio/mc/cmd.Version=2025-04-16T18:13:26Z -X github.com/minio/mc/cmd.CopyrightYear=2025 -X github.com/minio/mc/cmd.ReleaseTag=RELEASE.2025-04-16T18-13-26Z -X github.com/minio/mc/cmd.CommitID=b00526b153a31b36767991a4f5ce2cced435ee8e -X github.com/minio/mc/cmd.ShortCommitID=b00526b153a3' \
      -o /out/mc . && \
    GOTOOLCHAIN=local go mod verify

FROM alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c
LABEL org.opencontainers.image.source="https://github.com/minio/minio/tree/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      io.apollo.mc.source="https://github.com/minio/mc/tree/b00526b153a31b36767991a4f5ce2cced435ee8e"
COPY --from=minio-build /out/minio /usr/bin/minio
COPY --from=mc-build /out/mc /usr/bin/mc
COPY --from=minio-build /src/minio/LICENSE /licenses/minio/LICENSE
COPY --from=minio-build /src/minio/CREDITS /licenses/minio/CREDITS
COPY --from=mc-build /src/mc/LICENSE /licenses/mc/LICENSE
COPY --from=mc-build /src/mc/CREDITS /licenses/mc/CREDITS
COPY --from=minio-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
VOLUME ["/data"]
EXPOSE 9000 9001
ENTRYPOINT ["/usr/bin/minio"]
