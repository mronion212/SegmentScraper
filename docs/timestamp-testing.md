# Timestamp review branch

Branch: `improve-timestamp-discovery`. These changes are for branch testing, not a published release. Build outputs retain the current release version. Install the local `SegmentScraper.user.js` from this checkout to test the branch; the existing remote update URLs still point at `main`.

## Changes to test

- **API settings** now contains TVDB, IntroDB and TMDB together; collapsing it hides all three credential forms.
- **Mark timestamps from video** lets users choose Intro, Recap or Outro, confirm the playing title/episode, and use **Start here** / **End here**. Each mark pauses the video and reads its playback time, using a recent displayed-frame timestamp when available. Manual marks have no provider offset correction. Both boundaries must be explicit and valid.
- **Preview start** / **Preview end** play a short window around each boundary. Saving requires a review checkbox and stores a local candidate; uploading still needs separate approval. Changing the video, title, episode or type resets unfinished marks.
- **Show timestamps** filters by segment type. JSON export and upload approval apply to the visible type; switching filters clears approvals. Partial exports retain the captured session. Desktop comparison has the same type filter and approval behavior.
- Netflix, Prime Video, Videoland and SkyShowtime series captures retain revised boundaries instead of ignoring a later observation. Exact repeated captures remain deduplicated.
- Capture evidence records provider, source category, original numeric boundaries, unit and start correction. Netflix movie credits still use the existing six-second correction, now visible beside the original value.
- Shared validation rejects missing, blank, boolean, non-finite, reversed and out-of-duration boundaries when a duration is known. A genuine start at zero remains valid. No missing end is invented.
- Competing ranges for the same canonical title, episode and segment type are withheld. After watching the video, choose **Use this range after video review**. The comparison and API checks run again. A new distinct candidate invalidates the previous choice.
- Alternatives survive reload and partial exports. New captures during review prevent using an outdated export or upload approval. Timing evidence stays in recovery/reports; submission JSON contains only API fields.
- Desktop uses the same boundary and candidate rules, rejects competing same-type draft ranges, and labels ranges matching chapters or analysis suggestions. Remove alternatives from the upload editor after review; source chapters and analysis remain in the local report. Manual edits are labelled separately. Checks use video-stream duration when available.
- Provider marking excludes offscreen players and videos hidden by a parent element; multiple visible players still require an unambiguous selection. Reset/save stops an active boundary preview. Interrupted playback promises cannot cancel a newer preview.
- Desktop **Set start here** / **Set end here** pauses the review video and reads its actual playback clock, including the clip's source offset. A stale timeline display cannot become a timestamp. Loading, seeking, failed or out-of-clip playback is rejected.

## Automated checks

```powershell
npm run build
npm test
npm run check:desktop-core
```

The tests cover manual marking and video changes, boundary previews, filtered exports/approvals, candidate selection/invalidation, canonical episode conflicts, preserved alternatives, session recovery, invalid values, raw timing evidence, all four active provider adapters, desktop payloads and generated-client parity.

## Local browser fixture

```powershell
node benchmark/serve-player-ui.cjs
```

Open `http://127.0.0.1:8096` and click **Preview conflicting timestamps**. Both ranges start unavailable. Choose the second range: exactly one becomes NEW, the original raw timestamp and −6-second correction remain visible, and the other range stays listed. Choosing the first range switches the selection. This fixture makes no streaming requests or uploads. Existing player-control checks should still report 63 passed.

Open `http://127.0.0.1:8096/manual` for the manual capture fixture. This uses a simulated player clock, not video decoding. Choose **Start here** at 10 seconds, **Seek to 25s**, then **End here**. Tick the review checkbox and save: the local result must be 10–25 seconds. Open **Show timestamps**, select Recap and verify the Intro disappears and the empty export is disabled. Repeat with each provider theme. Verify all three credentials are inside **API settings**. Use **Switch video** between marks to check reset behavior. No credentials are saved and no provider/API requests or uploads are made by this fixture.

## Real playback checks

1. Install this checkout's generated userscript and reload the provider page. Open an episode and verify the range against playback, including a recap starting at zero.
2. In **Show timestamps**, check the source, original unit and raw boundaries. For Netflix movies, compare the original credits offset with the corrected start. The six-second correction is an existing heuristic, not newly verified timing accuracy.
3. If the provider returns competing ranges, review both starts/ends, choose one, and verify that only that range is eligible. Reload the page and check that observations and the choice survive. Final upload still needs its own explicit approval.
4. Open a different title while a review is open. The old export/upload action must ask for a fresh review. No live IntroDB submission is needed for these checks.
5. In desktop, inspect a file with labelled chapters. Try a blank boundary, an end past the video duration, and two non-overlapping ranges of the same type: validation must reject them. Keep one reviewed range and verify the source label in the comparison.
6. In a provider episode, open **Mark timestamps from video**, choose the segment type and enter the actual season, episode and episode title. Confirm the IMDb identity above, seek to the start and choose **Start here**, then seek to the end and choose **End here**. Preview both boundaries, tick the review checkbox, and save. Verify that Show timestamps labels the source `manual` and preserves the exact chosen times. TVDB title matching is required before upload.
7. Mark an intro and recap, filter each type in **Show timestamps**, and verify only the visible type is exported/approved. Change the filter after approval: the previous approval must be cleared. Repeat the approval check in desktop comparison. Change episodes while a mark is unfinished and verify it cannot be saved for the old episode.
8. Start a provider boundary preview and reset the marks before it finishes: playback must pause. In desktop, play a 1× review clip and immediately select **Set start here**: playback pauses, the source clock updates and the stored boundary must match it. Marking during a seek or before the clip loads must leave the previous boundary unchanged.

Online movie exclusion for known extra scenes and the temporary non-Netflix movie gate remain in place, including manual captures. Online manual movie marking supports only an explicitly bounded outro. Desktop keeps its separate reviewed scene-safe outro/scene policy. Multiple real scenes stay in local reports. Additional network interception and a finer second analysis pass remain follow-up work. Local automated and simulated-player checks do not establish timing accuracy or player compatibility on a live streaming service.
