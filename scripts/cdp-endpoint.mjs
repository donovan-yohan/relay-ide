export function devToolsEndpointFromOutput(output) {
  return output.match(/(?:^|\r?\n)DevTools listening on (ws:\/\/[^\r\n]+)\r?\n/)?.[1];
}

export function devToolsEndpointFromActivePort(contents) {
  const [portText, path] = contents.split(/\r?\n/, 3);
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !path?.startsWith("/devtools/browser/")) {
    return undefined;
  }
  return `ws://127.0.0.1:${port}${path}`;
}
