// Just-enough UPnP SOAP for a TV's DLNA renderer (RenderingControl /
// AVTransport): one POST per action, the answer's simple tags as an object.
const ENVELOPE = (service, action, args) =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">` +
  Object.entries(args)
    .map(([k, v]) => `<${k}>${String(v).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</${k}>`)
    .join('') +
  `</u:${action}></s:Body></s:Envelope>`;

export class SoapError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// controlUrl e.g. http://tv:9197/upnp/control/RenderingControl1
export async function soap(controlUrl, service, action, args = {}, timeout = 2000) {
  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: `"urn:schemas-upnp-org:service:${service}:1#${action}"`,
    },
    body: ENVELOPE(service, action, { InstanceID: 0, ...args }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) {
    const why = text.match(/<errorDescription>([^<]*)</)?.[1] ?? `HTTP ${res.status}`;
    throw new SoapError(`${action}: ${why}`, res.status);
  }
  const body = text.match(new RegExp(`<u:${action}Response[^>]*>([\\s\\S]*?)</u:${action}Response>`))?.[1] ?? '';
  const out = {};
  for (const m of body.matchAll(/<([A-Za-z_]+)>([^<]*)<\/\1>/g)) out[m[1]] = m[2].trim();
  return out;
}
