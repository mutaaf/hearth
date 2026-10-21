// The classifier is shared with the browser, so it lives in web/ (pure ESM,
// no Node APIs) and the hub imports it from here.
export { classify, summarize, suggestedMode, KINDS } from '../web/activity.js';
