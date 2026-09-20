# SegmentScraper Desktop

Inspect embedded chapters, automatically analyze movie endings, review timestamps, and contribute to **IntroDB (introdb.app)**. This complements streaming-provider metadata. Ending analysis is a visual heuristic, not a trained scene-recognition model or automatic intro detector.

## Install and use

Run `dist/SegmentScraper-Desktop-1.11.0-x64-Setup.exe`, or the Portable EXE. ffprobe and FFmpeg are bundled.

1. Choose local files/a season folder, or connect the same TorBox account used in Nuvio. Torrents, Usenet and web downloads are supported. Real-Debrid supports existing torrents. No content is added to TorBox.
2. Inspect directly from your provider, or download and inspect. Remote inspection uses bandwidth and may read substantial data. Completed downloads remain on disk.
3. Choose **Review for IntroDB** on a completed inspection. No chapters means ffprobe found no embedded chapter entries, not that the video has no intro or credits. Inspect the downloaded file to rule out remote-access limitations. Short videos are flagged as possible trailers/samples.
4. Enter your IntroDB key, TMDB read access token for movies, and TheTVDB key/optional subscriber PIN for TV. Upload credentials stay in backend memory for this session; saving replaces all four fields. Provider accounts can separately be remembered using Electron safeStorage encryption.
5. Search by title or IMDb ID and select the correct movie/series. For TV, enter the actual episode title and positive season/episode numbers. Season 0/specials are excluded.
6. For movies, choose **Analyze ending**. It automatically scans the last quarter (optionally half/full video), finds credit-like imagery/black transitions, and generates candidate scene boundaries, a 12× ending overview, and short boundary clips. Review these rather than watching the whole movie. Mark each candidate as a real scene or false positive. **Use detected timestamps** drops rejected candidates. Correct the times as needed and confirm the ending review.
7. Run the checks. Review canonical numbering, exact payload, progress and blocking reasons. Watch and verify every boundary yourself, tick the required acknowledgment, and upload.

## Checks and script parity

`build/desktop-core.cjs` generates `app/shared-core.mjs` from the existing userscript modules. Build/test hooks regenerate it. TVDB episode matching, normalized unique titles, ambiguity rejection, translated titles and TMDB extra-scene detection use the existing implementation.

The desktop checks finite numeric boundaries, ordering, overlap and actual duration. Both clients share timing rules and the IntroDB payload builder in `src/core/output-policy.js`: minimum 5 seconds; movie outro/post-credits maximums 900/600 seconds. IntroDB does not accept movie intro/recap submissions. IMDb identity/media type are verified. Missing TMDB keywords do not prove scene absence.

**Intentional policy difference:** the online userscript still withholds the entire movie when extra scenes are known. Desktop accepts a reviewed, scene-safe outro plus a separately bounded scene. Known chapter/IntroDB/TMDB scene indications cannot silently disappear: a missing scene range blocks normal upload. Final acknowledgment is always required.

## Analysis and IntroDB movie convention

The [movie documentation](https://introdb.app/docs/movies) explicitly says the outro ends at the scene start and post-credits covers the actual scene, including mid-credits scenes. Its older worked example overlaps the ranges; desktop follows the explicit mid-credits rule to avoid skipping a scene. `mid-credits` is a local classification, not an API segment type. The wire type remains `post-credits`. No invented `credits_start`, `film_einde`, `credit_part`, or scene-array fields are sent.

IntroDB returns one aggregated scene and does not model credits after that scene. Multiple same-type submissions would compete in aggregation; they are not a multi-scene playlist. Desktop preserves all candidates locally, but more than one confirmed real scene cannot be uploaded or bypassed with an admin code. Reject false positives before validation, or export the full report for a truly multi-scene movie. The app never merges several scenes into one fabricated range or uses EOF as the scene end.

FFmpeg decodes only the chosen window. Full-rate black detection is combined with dark-background text-component heuristics at 320×180 / 2 fps. Candidate resolution is approximately 0.5 seconds; nearby black transitions refine boundaries. Credits over live action, stylized graphics, dark scenes, logos and scenes without fades can confuse the heuristic. No candidates means unknown, not proven absence. A candidate reaching EOF without an end transition remains unresolved. Review the 12× overview and boundary clips and correct or widen the scan when needed. This has synthetic-video regression coverage, not a measured accuracy claim on a representative film dataset.

Preview clips are generated locally with FFmpeg and exposed only by opaque IDs on the loopback server. Source paths and provider URLs are not preview endpoints. They are deleted on clear/normal shutdown; a forced crash may leave `segmentscraper-analysis-*` temporary folders. Provider analysis obtains a fresh private link and uses provider bandwidth for scanning and previews; download locally if the provider cannot seek reliably. Cancellation stops FFmpeg. Reports include candidate evidence and warnings, not source links or keys.

A local selection is an incomplete catalogue: the desktop requires exact, unique episode-title matching rather than inferring order from equal counts. The shared TVDB loader follows pagination. Movies bypass TVDB. Duplicates are checked against fresh IntroDB data: exact ranges are skipped, differing ranges may be submitted as corrections. Network errors block instead of implying an empty database. Successful session submissions are tracked to avoid repeats. Failed/uncertain uploads stop the batch and require fresh checks before retrying. Requests time out after 15 seconds; checks expire after 15 minutes. Editing requires new checks.

Queue, drafts and reports are in memory. Export inspection/upload results before closing.

## Admin override

Set `SEGMENTSCRAPER_ADMIN_CODE` in the desktop process environment before starting it. No default or hard-coded code is shipped. The backend uses a constant-time digest comparison and attempt limit. Force upload requires personal review and a written reason. Failed checks and the reason are recorded in `upload-audit.jsonl` in Electron's user-data directory, without the code/API keys.

This local operator override bypasses review-policy failures, including unavailable lookups. It cannot bypass malformed IDs, invalid/out-of-video/overlapping boundaries, unsupported multiple scene ranges, specials, the update gate, or IntroDB authentication/validation/rate limits. People controlling the local installation can change its configuration; centralized administrative enforcement requires a separate trusted service.

## Required updates

Electron checks stable GitHub releases on startup and every 30 minutes. Only releases with a Windows Setup asset count. A confirmed newer version opens a non-dismissible dialog and blocks backend mutations until installation and restart. Reports remain exportable. The button opens the fixed repository releases page; the user installs the update. Known mandatory versions persist offline. A failed first check is not mistaken for an available update.

Publish a higher version with `SegmentScraper-Desktop-VERSION-x64-Setup.exe` on a stable GitHub release. A userscript-only update cannot lock the desktop. Version 1.9.5 needs a one-time manual upgrade because it has no checker. Builds are currently not code-signed.

## Development

```powershell
npm ci
npm run setup:media
npm test
npm run app
npm run dist:win
```

Browser development: `npm run app:web`, with `FFPROBE_PATH` and `FFMPEG_PATH` pointing to the corresponding binaries. Native dialogs, encrypted provider storage, persistent override audit and the desktop update checker belong to Electron. `DOWNLOAD_DIR` controls the web development download folder.

Applicable userscript changes must reach desktop in the same change (see root `AGENTS.md`). Regenerate both outputs. `node build/desktop-core.cjs --check` and CI detect stale desktop code; bundler tests detect stale userscript output. Client-specific movie scene policies have separate regression tests.

Tests cover real generated MKV chapters and mocked provider/IMDb/TVDB/TMDB/IntroDB requests, payloads, duplicates, failures, overrides and backend update enforcement. Live uploads require your own keys and reviewed timestamps.

Reference: [official IntroDB docs](https://api.introdb.app/) and [OpenAPI schema](https://api.introdb.app/openapi.json), captured in `introdb-openapi.json` on 2026-09-20. Upload: `POST /submit`, `X-API-Key`, `imdb_id`, `segment_type`, `start_sec`, `end_sec`, plus `is_movie: true` or canonical `season`/`episode`. This is not TheIntroDB v3.
