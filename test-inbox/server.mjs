import http from 'node:http';

const server = http.createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  if (request.url === '/fail') {
    setTimeout(() => response
      .writeHead(503, 'Service Unavailable', { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Synthetic unsubscribe provider is temporarily unavailable. Please retry later.'), 8000);
    return;
  }
  if (request.url === '/fail-json') {
    response
      .writeHead(422, 'Unprocessable Content', { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({
        error: 'subscription_not_found',
        message: 'No active subscription exists for this recipient.',
        retryable: false
      }));
    return;
  }
  if (request.url === '/success') {
    response.writeHead(200).end();
    return;
  }
  response.writeHead(404).end();
});

server.listen(8765, '127.0.0.1', () => {
  console.log('[test inbox] listening on http://127.0.0.1:8765');
});
