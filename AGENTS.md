# SegmentScraper maintenance

- Treat the userscript and desktop app as two clients of the same product. For every userscript change, assess desktop applicability in the same change and carry applicable lookup, mapping, validation, API and duplicate-handling updates into the desktop app.
- Keep reusable rules in `src/core` and regenerate both `SegmentScraper.user.js` and `app/shared-core.mjs`. Do not edit generated files manually. Run parity/regression tests for both clients.
- Intentional policy difference: the online userscript must not export/submit movie outros when a mid-/post-credits scene is known. Desktop may submit a reviewed, scene-safe outro and an explicitly bounded scene after local analysis. Do not copy the online blanket exclusion into the desktop.
- Follow current **introdb.app** documentation, not TheIntroDB. Preserve movie-scene boundaries; never infer absence from missing metadata or invent an end at EOF. Do not send multiple same-type scene ranges unless the official API documents that model. Keep unsupported multi-scene analyses locally for review/export.
- The desktop UI and errors must remain English. Analysis suggestions require final manual review and explicit upload. Provide short preview clips so users need not watch the whole movie.
