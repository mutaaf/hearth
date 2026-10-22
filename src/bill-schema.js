// The power bill: what leaves the house, what we ask the model, and how we
// check its answer. Shared by the phone (web/energy.js, served as
// vendor/bill-schema.js), the home hub (src/energy.js) and the cloud Worker
// (src/worker). Pure functions, no imports.
//
// Privacy: a bill carries a name, a service address and an account number.
// None of that is needed to price a kWh, so only the lines that talk about
// money, kWh, rates or the billing period are kept, and even those are
// scrubbed of long digit runs (account/meter numbers), emails and phone
// numbers. The phone shows the person exactly these lines before sending.
// Photos are cropped by the person to the charges box (see web/energy.js).

const KEEP = /(kwh|kw\b|¢|\$|€|£|usd|cad|aud|eur|gbp|rate|charge|usage|used|energy|electric|delivery|supply|distribution|transmission|generation|fuel|rider|adjust|surcharge|tax|fee|total|amount|balance|billing|period|days|tier|peak|summer|winter|basic|customer charge|service charge|per\b|\bat\b)/i;
const DROP = /(account|acct|customer (no|number|id|name)|name\b|service address|mailing|address|street|phone|tel\b|email|e-mail|[\w.+-]+@[\w-]+\.[a-z]|meter (no|number|#|id)|premise|po box|p\.o\.|pay(ment)? to|remit|routing|card|autopay|www\.|https?:)/i;
const STREET = /\b\d{1,6}\s+[A-Za-z][\w.]*(\s+[A-Za-z][\w.]*){0,3}\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|way|pl|place|cir|pkwy|hwy|trl|ter)\b\.?/i;
const ZIP = /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/;

export const BILL_LIMITS = { lines: 120, chars: 8000, imageBytes: 1_600_000 };

// Text of a bill → only the lines worth sending, scrubbed.
export function chargeLines(text) {
  const out = [];
  let chars = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.replace(/\s+/g, ' ').trim();
    if (!line || !/\d/.test(line) || !KEEP.test(line) || DROP.test(line) || STREET.test(line) || ZIP.test(line)) continue;
    line = line
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '')
      .replace(/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, '#')
      .replace(/\d[\d -]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '#' : m)) // account/meter numbers, not dates or 1,234
      .slice(0, 160)
      .trim();
    if (!line || out.at(-1) === line) continue;
    if (chars + line.length > BILL_LIMITS.chars || out.length >= BILL_LIMITS.lines) break;
    out.push(line);
    chars += line.length + 1;
  }
  return out;
}

export const BILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'total', 'kwh', 'days', 'period_start', 'period_end', 'energy_rate', 'fixed_charges', 'price_per_kwh', 'confidence', 'note'],
  properties: {
    currency: { type: 'string' },
    total: { type: 'number' },
    kwh: { type: 'number' },
    days: { type: 'integer' },
    period_start: { type: 'string' },
    period_end: { type: 'string' },
    energy_rate: { type: 'number' },
    fixed_charges: { type: 'number' },
    price_per_kwh: { type: 'number' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string' },
  },
};

export const BILL_SYSTEM = `You read electricity bills for Hearth, a home TV remote that estimates what each TV costs to run. You get either the charge lines of one bill (text) or a photo of its charges section. Personal details have been removed; ignore any that slipped through and never repeat them.
Return one JSON object only:
- "currency": ISO code (USD, EUR, GBP, CAD, AUD…).
- "total": the electricity charges for this period in currency units (not past-due balances, not gas or water). 0 if not shown.
- "kwh": kWh used in this period. 0 if not shown.
- "days": days in the billing period. 0 if not shown.
- "period_start", "period_end": YYYY-MM-DD, or "" if not shown.
- "energy_rate": the main per-kWh energy/supply rate in currency units per kWh (12.5¢ → 0.125). 0 if not shown.
- "fixed_charges": the monthly charges that don't depend on usage (customer/basic/service/meter charge), summed. 0 if none.
- "price_per_kwh": what one more kWh costs, all in: every per-kWh charge (energy, delivery, transmission, fuel, riders) plus usage-based taxes. If you can't add them up, use (total - fixed_charges) / kwh.
- "confidence": "high" if the numbers are printed plainly, "medium" if you combined or inferred some, "low" if guessing.
- "note": one short sentence for the household, e.g. "Tiered rate; the higher tier applies above 1,000 kWh." No personal details.
Use only numbers that appear on the bill. Never invent a value: use 0 or "".
Example: {"currency":"USD","total":142.37,"kwh":918,"days":30,"period_start":"2026-09-01","period_end":"2026-09-30","energy_rate":0.0921,"fixed_charges":9.5,"price_per_kwh":0.1447,"confidence":"high","note":"Flat rate plus delivery charges."}`;

export const billPrompt = (lines) => `Charge lines from one electricity bill:\n${lines.join('\n')}`;
export const BILL_IMAGE_PROMPT = 'Photo of the charges section of one electricity bill.';

const num = (v) => {
  const n = typeof v === 'string' ? Number.parseFloat(v.replace(/[^\d.-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The model's answer → clean numbers, or null when there's no usable price.
// The price is cross-checked against total/kWh, the arithmetic the model is
// worst at.
export function validateBill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const currency = /^[A-Z]{3}$/.test(String(raw.currency ?? '').toUpperCase()) ? String(raw.currency).toUpperCase() : 'USD';
  const total = Math.max(0, num(raw.total));
  const kwh = Math.max(0, num(raw.kwh));
  const days = Math.max(0, Math.min(400, Math.round(num(raw.days))));
  let energyRate = Math.max(0, num(raw.energy_rate));
  if (energyRate > 3 && energyRate < 300) energyRate /= 100; // cents slipped through
  const fixed = Math.max(0, num(raw.fixed_charges));
  let price = Math.max(0, num(raw.price_per_kwh));
  if (price > 3 && price < 300) price /= 100;
  const derived = total > 0 && kwh > 0 ? Math.max(0, total - Math.min(fixed, total)) / kwh : 0;
  let source = 'bill';
  // The model's sum is off by more than 35% from the bill's own arithmetic:
  // trust the arithmetic.
  if (derived && (!price || Math.abs(price - derived) / derived > 0.35)) {
    price = derived;
    source = 'total÷kWh';
  }
  if (!price && energyRate) {
    price = energyRate;
    source = 'energy rate';
  }
  if (!(price >= 0.01 && price <= 2)) return null;
  const start = DATE.test(raw.period_start ?? '') ? raw.period_start : '';
  const end = DATE.test(raw.period_end ?? '') ? raw.period_end : '';
  return {
    currency,
    pricePerKwh: Math.round(price * 10000) / 10000,
    priceSource: source,
    total: Math.round(total * 100) / 100,
    kwh: Math.round(kwh),
    days: days || (start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1 : 0),
    start,
    end,
    energyRate: Math.round(energyRate * 10000) / 10000,
    fixed: Math.round(fixed * 100) / 100,
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
    note: String(raw.note ?? '').replace(/\d[\d -]{6,}\d/g, '#').slice(0, 200),
  };
}

// A cropped photo, as the phone sends it: a JPEG/PNG/WebP data URL, capped.
export function checkImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) return null;
  if (m[2].length * 0.75 > BILL_LIMITS.imageBytes) return null;
  return { mime: `image/${m[1]}`, base64: m[2], dataUrl: String(dataUrl) };
}
