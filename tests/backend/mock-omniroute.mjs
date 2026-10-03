// OmniRoute giả lập, chỉ dùng để kiểm thử backend và giao diện (không phải OmniRoute thật).
import http from 'node:http';

export function startMock(port = 0) {
  const state = { last: null, requests: 0, aborted: 0, authHeaders: [] };
  const server = http.createServer(async (req, res) => {
    state.authHeaders.push(req.headers.authorization || null);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state));
    }
    if (url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'cc/claude-sonnet-4-6', object: 'model', owned_by: 'claude' },
            { id: 'gemini/gemini-2.5-pro', object: 'model', owned_by: 'gemini' },
            { id: 'oc/free-model', object: 'model', owned_by: 'opencode' },
            { id: 'my-combo', object: 'model', owned_by: 'combo' },
            { id: 'bad id with spaces', object: 'model' },
            ...(process.env.MOCK_EXTRA_MODELS ? process.env.MOCK_EXTRA_MODELS.split(',').map((id) => ({ id, object: 'model' })) : []),
          ],
        }),
      );
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      state.last = body;
      state.requests++;
      const routerHeaders = { 'X-OmniRoute-Decision': 'strategy=single; provider=claude; latency_ms=12', 'X-OmniRoute-Provider': 'claude', 'X-OmniRoute-Model': 'claude-sonnet-4-6' };
      const err = (status, message, extra = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
        res.end(JSON.stringify({ error: { message } }));
      };
      switch (body.model) {
        case 'fail-404':
          return err(404, 'Model fail-404 not found');
        case 'fail-429':
          return err(429, 'Too many requests', { 'Retry-After': '7' });
        case 'quota':
          return err(429, 'Your quota has been exhausted');
        case 'fail-500':
          return err(500, 'boom sk-abcdefghijklmnop1234');
        case 'fail-401':
          return err(401, 'Invalid API key');
        case 'hang':
          req.on('close', () => state.aborted++);
          return; // không bao giờ trả lời
        case 'cut-stream': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', ...routerHeaders });
          res.write('data: {"model":"claude-sonnet-4-6","choices":[{"delta":{"content":"Xin "}}]}\n\n');
          setTimeout(() => res.write('data: {"model":"claude-sonnet-4-6","choices":[{"delta":{"content":"chào"}}]}\n\n'), 50);
          setTimeout(() => res.destroy(), 120);
          return;
        }
        case 'slow-stream': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', ...routerHeaders });
          res.on('close', () => {
            if (!res.writableEnded) state.aborted++;
          });
          const words = ['Một', ' hai', ' ba', ' bốn', ' năm', ' sáu', ' bảy', ' tám'];
          let i = 0;
          const timer = setInterval(() => {
            if (i < words.length) {
              res.write(`data: ${JSON.stringify({ model: 'claude-sonnet-4-6', choices: [{ delta: { content: words[i++] } }] })}\n\n`);
            } else {
              clearInterval(timer);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }, 120);
          res.on('close', () => clearInterval(timer));
          return;
        }
        default:
          if (body.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', ...routerHeaders });
            res.write(`data: ${JSON.stringify({ model: 'claude-sonnet-4-6', choices: [{ delta: { content: 'Xin chào! ' } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ model: 'claude-sonnet-4-6', choices: [{ delta: { content: 'Đây là **trả lời thử** từ OmniRoute giả lập.' } }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.writeHead(200, { 'Content-Type': 'application/json', ...routerHeaders });
          return res.end(JSON.stringify({ model: 'claude-sonnet-4-6', choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMock(Number(process.env.MOCK_PORT || 20128));
  console.log('Mock OmniRoute chạy tại cổng', port);
}
