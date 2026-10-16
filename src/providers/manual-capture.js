import { createManualSegment } from '../core/output-policy.js';

/** Transient player bindings never enter session storage or exports. */
export function createManualCapture({ getContext, record, render, findVideo = findManualCaptureVideo }) {
  let draft = null, video = null, source = '', contextKey = '', frame = null, frameRequest = null, previewStop = null;
  const publish = message => render({ start: draft?.start ?? null, end: draft?.end ?? null, message });
  const stopPreview = () => {
    if (previewStop) {
      previewStop.video.removeEventListener('timeupdate', previewStop.listener);
      if (previewStop.video.currentSrc === previewStop.source) previewStop.video.pause();
    }
    previewStop = null;
  };
  const reset = (message = 'Choose the segment type, then pause at each boundary and mark it.') => {
    stopPreview();
    if (video) {
      video.removeEventListener('emptied', changed);
      video.removeEventListener('loadstart', changed);
      if (frameRequest != null) video.cancelVideoFrameCallback?.(frameRequest);
    }
    draft = null; video = null; frame = null; frameRequest = null;
    publish(message);
  };
  const changed = () => reset('Video changed. Confirm the playing title/episode and mark both boundaries again.');
  const bind = current => {
    video = current;
    source = video.currentSrc;
    video.addEventListener('emptied', changed);
    video.addEventListener('loadstart', changed);
    const observe = (_, metadata) => {
      if (video !== current) return;
      frame = { time: metadata.mediaTime, clock: current.currentTime };
      frameRequest = current.requestVideoFrameCallback(observe);
    };
    if (typeof video.requestVideoFrameCallback === 'function') frameRequest = video.requestVideoFrameCallback(observe);
  };
  const current = () => {
    const context = getContext();
    const key = JSON.stringify(context);
    const found = findVideo();
    if (!found || !Number.isFinite(found.duration) || found.duration <= 0 || !Number.isFinite(found.currentTime) || found.seeking) {
      throw new Error('Wait for one visible video to load and finish seeking. Multiple visible videos cannot be marked safely.');
    }
    if (draft && (video !== found || source !== found.currentSrc || contextKey !== key || draft.duration !== found.duration)) {
      changed(); throw new Error('Video or episode changed. Mark the start again.');
    }
    if (!draft && video && (video !== found || source !== found.currentSrc || contextKey !== key)) reset();
    if (!video) { bind(found); contextKey = key; }
    return context;
  };
  const mark = which => {
    const context = current();
    if (which === 'end' && !draft) throw new Error('Mark the start first.');
    stopPreview();
    video.pause();
    // A fresh displayed-frame time is useful; after a seek use the media clock.
    const time = frame && Math.abs(frame.clock - video.currentTime) < 0.05 && Math.abs(frame.time - video.currentTime) < 0.2 ? frame.time : video.currentTime;
    if (which === 'start') draft = { ...context, start: time, end: null, duration: video.duration };
    else draft.end = time;
    publish(which === 'start' ? 'Start marked. Play or seek to the end, then choose End here.' : 'End marked. Preview both boundaries, then save the reviewed segment.');
  };
  const preview = which => {
    current();
    const time = draft?.[which];
    if (!Number.isFinite(time)) throw new Error(`Mark the ${which} first.`);
    stopPreview();
    const currentVideo = video, end = Math.min(video.duration, time + 2);
    const pending = { video: currentVideo, source: currentVideo.currentSrc, listener: null };
    pending.listener = () => { if (previewStop === pending && currentVideo.currentTime >= end) stopPreview(); };
    previewStop = pending;
    const failed = () => {
      // An old play() rejection must not cancel a newer preview or show a stale error.
      if (previewStop !== pending) return;
      stopPreview();
      throw new Error('Use the player’s Play button to preview this boundary.');
    };
    try {
      currentVideo.pause();
      currentVideo.currentTime = Math.max(0, time - 2);
      currentVideo.addEventListener('timeupdate', pending.listener);
      return Promise.resolve(currentVideo.play()).catch(failed);
    } catch (_) { return failed(); }
  };
  const save = reviewed => {
    current();
    if (!reviewed) throw new Error('Confirm that you checked the title/episode and both boundaries.');
    if (!draft) throw new Error('Mark both boundaries first.');
    const item = createManualSegment(draft);
    record(item);
    reset(`Saved ${item.segment_type}: ${item.start_sec.toFixed(3)}–${item.end_sec.toFixed(3)} s. Open Show timestamps to review/export.`);
    return item;
  };
  return { mark, preview, save, reset };
}

export function findManualCaptureVideo() {
  const root = document.fullscreenElement || document;
  const candidates = root.matches?.('video') ? [root] : [...root.querySelectorAll('video')];
  const visible = candidates.filter(video => {
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= window.innerHeight || rect.left >= window.innerWidth || video.readyState < 2) return false;
    for (let element = video; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || Number(style.opacity) === 0) return false;
    }
    return true;
  });
  return visible.length === 1 ? visible[0] : null;
}
