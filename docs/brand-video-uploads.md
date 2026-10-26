# Brand Kit video uploads

New assets use authenticated 8 MiB chunks, with an original-file limit of 500 MiB and a ten-minute video limit. Chunk sessions belong to the farm and the uploading user. They expire after 24 hours. Keep the browser page open: retry resumes its retained File/session from the server's committed offset. Resuming after closing/reloading the page is not implemented; select the file again. Finalization uses the session UUID as the asset UUID so a lost completion response cannot create a duplicate new asset.

The queue sends one file at a time, keeps each result visible and continues after failure. Retry affects only the failed file. Successful assets are selected immediately in the pack. Save the pack normally. Existing assets are never re-uploaded automatically. The legacy replacement endpoint remains streamed, not chunked; this release's resumable flow is for new assets.

Original bytes are uploaded before conversion. After fail-closed malware scanning, FFmpeg creates H.264/AAC MP4, at most 1920 pixels on either dimension, 30fps, CRF23 with a duration-dependent maximum bitrate. It never upscales. Output above 200 MiB is rejected. This is a web copy, not an archival-quality guarantee or a promise that every already-efficient original becomes smaller. Originals on the user's device are unchanged.

Storage checks count nested temporary files and reserve source plus output space. Session metadata and partial uploads live under the farm's existing private evidence directory. Expired unfinished sessions are cleaned when another session starts. Completed session receipts expire without deleting published media or processing sources. At most eight unfinished sessions per farm are allowed. Chunks are bounded in memory; malware scanning streams the source with backpressure. API farm upload serialization assumes the existing single API process; do not scale to multiple API processes without adding a distributed lock.

## Release requirements

- Deploy API and UI together on the patched supported runtime. No database migration.
- Recreate only the ClamAV service with the reviewed Compose settings: StreamMaxLength / MaxFileSize / PCREMaxFileSize 512M, MaxScanSize1024M, AlertExceedsMax yes. Preserve the existing signature volume, image and local-only port. Verify effective settings and a clean synthetic stream over 100 MiB before enabling uploads. Never bypass scanning.
- Existing nginx Brand upload location must allow chunk requests; the example's 520m also covers legacy streamed requests. Cloudflare receives individual chunks below 100 MB; no WAF bypass or global upload-limit increase is necessary.
- Preserve current source/config backups, private media, permissions and old hashed assets. Take an encrypted recovery backup and use the existing guarded release pattern. No real user media should be submitted by deployment tests.
- Dependency audits must pass before production deployment. A current Zod v3 security finding requires a separately reviewed v4 migration; do not suppress that finding.

## Verification on 26 October 2026

Both previously rejected originals were converted locally through the production transcode function, without uploading them or modifying the originals. The 109.8 MiB MOV produced an 83.5 MiB MP4 (1440×1920, 86 seconds); the 219.8 MiB MOV produced a 34.3 MiB MP4 (1080×1920, 35 seconds). Both outputs passed full FFmpeg decode checks and retained portrait orientation. These results are examples, not guaranteed compression ratios.

Regression coverage includes committed-offset recovery, chunk/total/quota limits, farm/user ownership, expired-session cleanup, database-failure recovery, idempotent finalization, serialization with legacy uploads, sequential UI uploads, individual retry and scanner rejection/disconnect behavior. No production asset or pack was created during verification.

Deployment remains blocked by GHSA-mrhx-c7xc-m3w5 in Zod <4.6.6. The audit now contains only that high-severity finding after updating fast-uri, Happy DOM and serialize-javascript. Do not describe this branch as deployed or security-clear until the Zod migration and release gates pass.
