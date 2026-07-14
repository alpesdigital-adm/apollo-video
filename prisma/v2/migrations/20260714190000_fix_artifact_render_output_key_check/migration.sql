ALTER TABLE "artifact_render_operations"
  DROP CONSTRAINT "artifact_render_operations_output_check",
  ADD CONSTRAINT "artifact_render_operations_output_check" CHECK (
    (
      "outputKey" IS NULL
      AND "outputSha256" IS NULL
      AND "outputByteSize" IS NULL
      AND "outputWidth" IS NULL
      AND "outputHeight" IS NULL
      AND "outputFps" IS NULL
      AND "outputDurationInFrames" IS NULL
      AND "outputCodec" IS NULL
      AND "outputContainer" IS NULL
      AND "outputAttempt" IS NULL
      AND "outputCommittedAt" IS NULL
      AND "outputRecordedAt" IS NULL
    )
    OR (
      "outputKey" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*\.mp4$'
      AND length("outputKey") <= 512
      AND "outputKey" !~ '//'
      AND "outputKey" !~ '(^|/)\.\.?(/|$)'
      AND "outputSha256" ~ '^[a-f0-9]{64}$'
      AND "outputByteSize" > 0
      AND "outputWidth" > 0
      AND "outputHeight" > 0
      AND "outputFps" > 0
      AND "outputDurationInFrames" > 0
      AND "outputCodec" = 'h264'
      AND "outputContainer" = 'mp4'
      AND "outputAttempt" > 0
      AND "outputCommittedAt" IS NOT NULL
      AND "outputRecordedAt" >= "outputCommittedAt"
    )
  );
