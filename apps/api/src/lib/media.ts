export interface FetchedMedia {
  buffer: Buffer;
  contentType: string;
}

// Twilio media URLs require the account's own credentials to fetch (04 §4.1 step 4) —
// they aren't publicly readable.
export async function fetchTwilioMedia(
  mediaUrl: string,
  accountSid: string,
  authToken: string,
): Promise<FetchedMedia> {
  const response = await fetch(mediaUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Twilio media (${response.status}): ${mediaUrl}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer, contentType };
}
