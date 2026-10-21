'use strict';
function describe(d, primaryId) {
  return { id: String(d.id), label: d.label || `显示器 ${d.id}`, internal: !!d.internal,
    primary: d.id === primaryId, bounds: d.bounds, scaleFactor: d.scaleFactor, size: d.size };
}
function bindingFor(d) { return { id: String(d.id), label: d.label || '', internal: !!d.internal }; }
function resolveDisplay(displays, primaryId, binding) {
  if (!binding) return null;
  const candidates = displays.filter(d => d.id !== primaryId && !d.internal);
  const exact = candidates.find(d => String(d.id) === binding.id && (!binding.label || d.label === binding.label));
  if (exact) return exact;
  // Names and resolutions are often shared by meeting displays. An OS id
  // change requires explicit rebinding rather than guessing a physical device.
  return null;
}
module.exports = { describe, bindingFor, resolveDisplay };
