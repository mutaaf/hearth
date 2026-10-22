// Apple TV model identifiers → names. Kept apart from the driver so discovery
// (and the phone app, which has no Python bridge) can use them.
// Friendly model names for the hardware identifiers Apple TVs announce.
const MODELS = {
  'AppleTV2,1': '2nd gen', 'AppleTV3,1': '3rd gen', 'AppleTV3,2': '3rd gen', 'AppleTV5,3': 'HD',
  'AppleTV6,2': '4K', 'AppleTV11,1': '4K (2nd gen)', 'AppleTV14,1': '4K (3rd gen)',
};
export const appleTvModel = (raw) => (raw ? MODELS[raw] ?? raw : '');
