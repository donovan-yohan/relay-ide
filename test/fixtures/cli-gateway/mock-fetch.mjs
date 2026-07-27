import { writeFileSync } from 'node:fs';

globalThis.fetch = async (url, init = {}) => {
  const body =
    typeof init.body === 'string' && init.body.length > 0
      ? JSON.parse(init.body)
      : undefined;
  const capturePath = process.env.RELAY_TEST_FETCH_CAPTURE;
  if (!capturePath) {
    throw new Error('RELAY_TEST_FETCH_CAPTURE is required');
  }
  writeFileSync(
    capturePath,
    JSON.stringify({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body,
    })
  );
  const data = String(url).includes('/channels/')
    ? { message: { id: 'chm:test' } }
    : {
        id: 'worker-session',
        type: 'terminal',
        mode: 'pty',
        agent: 'terminal',
        cwd: '/repo',
        status: 'active',
      };
  return new Response(JSON.stringify(data), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
};
