export async function* readSseData(stream) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* drainFrames(buffer, false);
    buffer = trailingPartialFrame(buffer);
  }

  buffer += decoder.decode();
  yield* drainFrames(buffer, true);
}

export function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function* drainFrames(buffer, includeTrailing) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const completeFrames = includeTrailing ? frames : frames.slice(0, -1);

  for (const frame of completeFrames) {
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  }
}

function trailingPartialFrame(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const lastSeparator = normalized.lastIndexOf("\n\n");
  if (lastSeparator === -1) return buffer;
  return normalized.slice(lastSeparator + 2);
}
