import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_HEADERS: Record<string, string> = {
  replicate: 'webhook-signature',
  fal: 'x-fal-signature',
  deepgram: 'x-deepgram-signature',
};

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function verifyReplicateSignature(
  headers: Record<string, string>,
  body: string,
  secret: string,
): Promise<boolean> {
  const headerName = SIGNATURE_HEADERS.replicate;
  const signatureHeader = headers[headerName] ?? headers[headerName.toLowerCase()];
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(',');
  let timestamp: string | undefined;
  let v1Digest: string | undefined;
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key.trim() === 't') timestamp = value?.trim();
    if (key.trim() === 'v1') v1Digest = value?.trim();
  }

  if (!timestamp || !v1Digest) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const age = Date.now() - ts * 1000;
  if (age < -MAX_TIMESTAMP_AGE_MS || age > MAX_TIMESTAMP_AGE_MS) return false;

  const signedPayload = `${timestamp}.${body}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');

  return constantTimeEqual(expected, v1Digest);
}

async function verifyFalSignature(
  headers: Record<string, string>,
  body: string,
  secret: string,
): Promise<boolean> {
  const headerName = SIGNATURE_HEADERS.fal;
  const signature = headers[headerName] ?? headers[headerName.toLowerCase()];
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return constantTimeEqual(expected, signature);
}

async function verifyDeepgramSignature(
  headers: Record<string, string>,
  body: string,
  secret: string,
): Promise<boolean> {
  const headerName = SIGNATURE_HEADERS.deepgram;
  const signature = headers[headerName] ?? headers[headerName.toLowerCase()];
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return constantTimeEqual(expected, signature);
}

async function verifyGenericSignature(
  headers: Record<string, string>,
  body: string,
  secret: string,
  headerName: string,
): Promise<boolean> {
  const signature = headers[headerName] ?? headers[headerName.toLowerCase()];
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return constantTimeEqual(expected, signature);
}

export async function verifyWebhookSignature(
  provider: string,
  headers: Record<string, string>,
  body: string,
  secret: string,
): Promise<boolean> {
  switch (provider) {
    case 'replicate':
      return verifyReplicateSignature(headers, body, secret);
    case 'fal':
      return verifyFalSignature(headers, body, secret);
    case 'deepgram':
      return verifyDeepgramSignature(headers, body, secret);
    default: {
      const headerName = SIGNATURE_HEADERS[provider];
      if (headerName) {
        return verifyGenericSignature(headers, body, secret, headerName);
      }
      return false;
    }
  }
}
