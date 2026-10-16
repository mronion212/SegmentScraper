# Changelog

## [1.12.7]

### Added

- Manual player marks and boundary previews, collapsed by default on every provider.
- Segment-type filtering for timestamp review, export and upload approval in both clients.
- Complete Videoland programme episode collection, including paginated season blocks.

### Fixed

- Episode totals can exclude extra future/undated TVDB entries while retaining early provider releases.
- TVDB retries refresh mismatched metadata; validation explains extra episodes and count differences.
- Videoland catalogue loading completes before export/upload; batching and repeated-content guards prevent excessive pagination requests.
- IMDb lookup retries TV provider suffixes such as “De Serie” and requires an exact fallback match.
- Revised timestamp candidates, zero-second starts, invalid boundaries and stale review approvals are handled consistently.

### Changed

- API settings are grouped, and provider panels show the running version.
- Applicable rules are shared with desktop; unused helpers and experimental Prime timestamp replay code are removed.
- Release assets include the userscript and Windows Setup/Portable builds. Desktop remains Alpha 0.1.

See [full release notes](release-notes/1.12.7.md) for validation, scope and local-test-build upgrade instructions.

## Earlier updates

The repository's userscript was already at 1.12.6 before this change; the latest separate GitHub Release was v1.12.4. This changelog does not create missing historical tags/releases.

- [1.12.6 notes](release-notes/1.12.6.md)
- [1.12.5 notes](release-notes/1.12.5.md)
- [1.12.4 notes](release-notes/1.12.4.md)

[1.12.7]: https://github.com/mronion212/SegmentScraper/releases/tag/v1.12.7
