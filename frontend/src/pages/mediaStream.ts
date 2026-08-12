export function stopMediaStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/**
 * Requests the mic and routes a permission denial through the same
 * user-facing message both session hooks show, since they were previously
 * duplicating this handling verbatim.
 */
export async function requestMicStream(
  constraints: MediaTrackConstraints | boolean,
  onDenied: (message: string) => void,
): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      onDenied('Microphone access was denied. Allow microphone access in your browser and try again.');
    } else {
      onDenied('Could not access the microphone.');
    }
    return null;
  }
}
