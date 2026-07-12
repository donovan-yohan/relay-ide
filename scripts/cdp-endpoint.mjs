export function devToolsEndpointFromOutput(output) {
  return output.match(/(?:^|\r?\n)DevTools listening on (ws:\/\/[^\r\n]+)\r?\n/)?.[1];
}
