import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chargeLines, checkImage, validateBill } from '../src/bill-schema.js';
import { billRequest, Energy, estimatePower, screenSize } from '../src/energy.js';
import { Telemetry } from '../src/telemetry.js';
import { checkBillRequest } from '../src/worker/index.js';

const BILL = `
Riverbend Power & Light
JANE Q. SAMPLE
1234 Maple Grove Dr
Springfield, IL 62704
Account Number: 4401 2233 9087
Customer Name: Jane Sample
Service Address: 1234 Maple Grove Dr Apt 2
Meter Number 88123456 Phone (217) 555-0143
Questions? help@riverbend.example www.riverbend.example
Billing Period: 09/01/2026 - 09/30/2026 (30 days)
Total kWh used 918 kWh
Customer Charge $9.50
Energy Charge 918 kWh @ $0.0921 $84.55
Delivery Charge 918 kWh @ $0.0412 $37.82
Fuel Adjustment 918 kWh @ $0.0050 $4.59
State Tax $5.91
Total Electric Charges $142.37
Previous Balance $131.20
Pay to: Riverbend Power, PO Box 4410
`;

test('only charge lines leave the house: no name, address, account, meter, phone or email', () => {
  const lines = chargeLines(BILL);
  const sent = lines.join('\n');
  for (const secret of ['JANE', 'Jane', 'Maple', '62704', '4401', '2233 9087', '88123456', '555-0143', 'help@', 'www.', 'PO Box', 'Springfield']) {
    assert.ok(!sent.includes(secret), `${secret} must not be sent:\n${sent}`);
  }
  for (const keep of ['918 kWh', '$0.0921', '$9.50', '$142.37', 'Billing Period: 09/01/2026 - 09/30/2026']) assert.ok(sent.includes(keep), `${keep} is needed`);
  assert.ok(lines.length >= 7 && lines.length <= 12);
});

test('the model’s answer is checked: cents, the total÷kWh cross-check, nonsense', () => {
  const good = validateBill({ currency: 'usd', total: 142.37, kwh: 918, days: 30, period_start: '2026-09-01', period_end: '2026-09-30', energy_rate: 9.21, fixed_charges: 9.5, price_per_kwh: 0.1447, confidence: 'high', note: 'Flat rate.' });
  assert.equal(good.currency, 'USD');
  assert.equal(good.energyRate, 0.0921, 'cents become dollars');
  assert.equal(good.pricePerKwh, 0.1447);
  assert.equal(good.priceSource, 'bill');
  // A model that added things up badly: the bill's own arithmetic wins.
  const off = validateBill({ total: 142.37, kwh: 918, fixed_charges: 9.5, price_per_kwh: 0.0921 });
  assert.equal(off.pricePerKwh, 0.1447);
  assert.equal(off.priceSource, 'total÷kWh');
  assert.equal(validateBill({ total: 0, kwh: 0, price_per_kwh: 45 }).pricePerKwh, 0.45, '45¢ typed as 45');
  assert.equal(validateBill({ price_per_kwh: 0 }), null);
  assert.equal(validateBill({ price_per_kwh: 0.001 }), null);
  assert.equal(validateBill('nope'), null);
  assert.match(validateBill({ price_per_kwh: 0.2, note: 'Account 4401223390 was billed' }).note, /Account # was/);
});

test('screen sizes and watts from model codes', () => {
  assert.equal(screenSize('UN55KU6290'), 55);
  assert.equal(screenSize('55UP7000PUA'), 55);
  assert.equal(screenSize('OLED65C3PUA'), 65);
  assert.equal(screenSize('TCL 65A300W'), 65);
  assert.equal(screenSize('QN85Q80C'), 85);
  assert.equal(screenSize('Streaming Stick 3840R'), null);
  const old = estimatePower({ brand: 'samsung', model: 'UN55KU6290', year: 2016 });
  const lg = estimatePower({ brand: 'lg', model: '55UP7000PUA', year: 2021 });
  assert.ok(old.onW > lg.onW, 'a 2016 panel draws more than a 2021 one');
  assert.ok(lg.onW >= 60 && lg.onW <= 100);
  assert.equal(estimatePower({ brand: 'roku', model: 'Streaming Stick 3840R' }).onW, 3);
  assert.equal(estimatePower({ brand: 'androidtv', model: 'TCL 65A300W', year: 2021 }).standbyW, 1.5);
});

test('energy report: measured hours on × watts × the bill’s price', async () => {
  const day = 86_400_000;
  const start = new Date('2026-10-10T00:00:00').getTime();
  let now = start;
  const tel = new Telemetry({ now: () => now });
  const tv = { id: 'tv', brand: 'lg', name: 'Living Room', model: '55UP7000PUA' };
  tel.state('tv', { online: true, power: 'off' });
  // Four days, on 6 h each evening.
  for (let d = 0; d < 4; d++) {
    now = start + d * day + 18 * 3_600_000;
    tel.state('tv', { online: true, power: 'on' });
    now += 6 * 3_600_000;
    tel.state('tv', { online: true, power: 'off' });
  }
  now = start + 4 * day;
  const energy = new Energy({ now: () => now });
  await energy.setWatts('tv', { onW: 100, standbyW: 0.5 });
  await energy.setBill({ currency: 'USD', pricePerKwh: 0.15, total: 150, kwh: 1000, days: 30, start: '2026-09-01', end: '2026-09-30', fixed: 0, energyRate: 0.15, confidence: 'high', note: '' });
  const r = energy.report([tv], tel, () => 2021);
  const row = r.tvs[0];
  assert.equal(row.onHPerDay, 6);
  assert.equal(row.daily.length, 4);
  // 6 h × 100 W + 18 h × 0.5 W = 0.609 kWh a day
  assert.equal(row.kwhPerDay, 0.609);
  assert.equal(row.perMonth, Math.round(0.609 * 30.44 * 0.15 * 100) / 100);
  assert.equal(row.watts.yours, true);
  assert.equal(r.price.source, 'bill');
  assert.equal(r.house.shareOfBill, Math.round(((0.609 * 30.44) / ((1000 / 30) * 30.44)) * 1000) / 10);
  await assert.rejects(energy.setPrice({ pricePerKwh: 9000 }), /between/);
  await energy.setPrice({ pricePerKwh: 21 }); // typed in cents
  assert.equal(energy.price.pricePerKwh, 0.21);
  await energy.clear();
  assert.equal(energy.price.source, 'default');
});

test('what the phone may send for a bill (hub and Worker agree)', () => {
  assert.throws(() => billRequest({ lines: ['hello'] }), /No charges/);
  assert.throws(() => billRequest({ image: 'data:image/gif;base64,AAAA' }), /too big or not/);
  const req = billRequest({ lines: BILL.split('\n') });
  assert.ok(!req.lines.join(' ').includes('Maple'), 'the hub scrubs again');
  assert.ok(checkImage('data:image/jpeg;base64,/9j/4AAQ'));
  assert.equal(checkImage(`data:image/jpeg;base64,${'A'.repeat(2_200_000)}`), null);
  assert.equal(checkBillRequest({ lines: ['x'] }, '').error, 'No charges found in that bill.');
  assert.match(checkBillRequest({ provider: 'anthropic', lines: BILL.split('\n') }, '').error, /complete key/);
  const ok = checkBillRequest({ lines: BILL.split('\n') }, '');
  assert.equal(ok.provider, 'edge');
  assert.ok(!ok.lines.join(' ').includes('4401'), 'the Worker scrubs a third time');
});
