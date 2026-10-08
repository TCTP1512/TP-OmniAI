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
    const MOCK_KEY = 'sk-mockkey-0123456789abcdef';
    const hasCookie = (req.headers.cookie || '').includes('auth_token=COOKIE123');
    const readBody = async () => {
      let raw = '';
      for await (const c of req) raw += c;
      try { return JSON.parse(raw || '{}'); } catch { return {}; }
    };
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const b = await readBody();
      if (b.password !== (process.env.MOCK_ADMIN || 'mat-khau-admin-2')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"bad password"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'auth_token=COOKIE123; Path=/; HttpOnly; Secure' });
      return res.end('{"success":true}');
    }
    if (url.pathname === '/api/keys' && req.method === 'POST') {
      if (!hasCookie) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"auth"}'); }
      const b = await readBody(); state.keyCreated = b;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ key: MOCK_KEY, id: 'k1', name: b.name }));
    }
    if (url.pathname === '/api/combos' && req.method === 'POST') {
      if (!hasCookie) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"auth"}'); }
      const b = await readBody(); state.comboCreated = b;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'c1', name: b.name }));
    }
    if (url.pathname === '/api/providers' && req.method === 'POST') {
      if (!hasCookie) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"auth"}'); }
      const b = await readBody(); state.providerAdded = b;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'p1', provider: b.provider }));
    }
    if (url.pathname === '/v1/models' && process.env.MOCK_REQUIRE_KEY && req.headers.authorization !== 'Bearer ' + MOCK_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"Authentication required","type":"invalid_api_key","code":"invalid_api_key"}}');
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
        case 'code-reply': {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', ...routerHeaders });
          res.write(`data: ${JSON.stringify({ model: 'claude-sonnet-4-6', choices: [{ delta: { content: 'Đây là mã:\n\n```python\nprint("hi")\n```\n' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        case 'no-creds':
          return err(401, 'No active credentials for provider: gemini');
        case 'retired':
          return err(404, 'This model models/gemini-2.5-flash is no longer available to new users.');
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
        default: {
          const imgs = body.messages.flatMap((x) => (Array.isArray(x.content) ? x.content.filter((p) => p.type === 'image_url') : [])).length;
          state.lastImages = imgs;
          if (imgs > 0) {
            const text = `Tôi thấy ${imgs} ảnh.`;
            if (body.stream) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', ...routerHeaders });
              res.write(`data: ${JSON.stringify({ model: 'claude-sonnet-4-6', choices: [{ delta: { reasoning_content: 'Đang xem ảnh… ' } }] })}\n\n`);
              res.write(`data: ${JSON.stringify({ model: 'claude-sonnet-4-6', choices: [{ delta: { content: text } }] })}\n\n`);
              res.write('data: [DONE]\n\n');
              return res.end();
            }
            res.writeHead(200, { 'Content-Type': 'application/json', ...routerHeaders });
            return res.end(JSON.stringify({ model: 'claude-sonnet-4-6', choices: [{ message: { role: 'assistant', content: text } }] }));
          }
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
