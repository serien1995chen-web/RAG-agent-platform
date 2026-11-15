import { createServer } from 'node:http';

const port = Number(process.env.B10_FIXTURE_PORT ?? 43100);
const hits = new Map<string, number>();

function page(title: string, body: string) {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
  hits.set(path, (hits.get(path) ?? 0) + 1);
  console.log(JSON.stringify({ path, hit: hits.get(path) }));
  const send = (
    status: number,
    contentType: string,
    body: string | Buffer,
    headers: Record<string, string> = {},
  ) => {
    response.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      ...headers,
    });
    response.end(body);
  };

  if (path === '/b10/reset') {
    hits.clear();
    send(200, 'application/json', '{"reset":true}');
    return;
  }
  if (path === '/b10/normal.html') {
    send(
      200,
      'text/html; charset=utf-8',
      page(
        'Normal Fixture',
        '<main><h1>Normal</h1><p>SELECTED_FIXTURE_TEXT NORMAL</p><a href="../relative">Relative</a></main><aside>OUTSIDE_TEXT</aside>',
      ),
    );
    return;
  }
  if (path === '/b10/selector.html') {
    send(
      200,
      'text/html; charset=utf-8',
      page(
        'Selector Fixture',
        '<nav>NAVIGATION_NOISE</nav><main id="article"><h1>Selector</h1><p>SELECTED_FIXTURE_TEXT SELECTOR</p></main><aside>OUTSIDE_TEXT</aside>',
      ),
    );
    return;
  }
  if (path === '/b10/noise.html') {
    send(
      200,
      'text/html; charset=utf-8',
      page(
        'Noise Fixture',
        '<main><i>ICON_NOISE</i><script>SCRIPT_NOISE</script><style>.hidden{}</style><p>SELECTED_FIXTURE_TEXT NOISE</p><a href="../next">Next</a><a href=" "></a><img src="../image.png" alt="fixture"></main>',
      ),
    );
    return;
  }
  if (path === '/b10/zh.html') {
    send(
      200,
      'text/html; charset=utf-8',
      page('中文夹具', '<main><h1>中文正文</h1><p>SELECTED_FIXTURE_TEXT 中文</p></main>'),
    );
    return;
  }
  if (path === '/b10/redirect/one') {
    send(302, 'text/html', '', { location: '/b10/normal.html' });
    return;
  }
  if (path === '/b10/redirect/private') {
    send(302, 'text/html', '', { location: 'http://169.254.169.254/latest/meta-data' });
    return;
  }
  if (path === '/b10/redirect/loop') {
    send(302, 'text/html', '', { location: '/b10/redirect/loop' });
    return;
  }
  if (path === '/b10/empty.html') {
    send(200, 'text/html', page('Empty', '<main><script>only()</script></main>'));
    return;
  }
  if (path === '/b10/no-selector-match.html') {
    send(200, 'text/html', page('No match', '<aside>OUTSIDE_TEXT</aside>'));
    return;
  }
  if (path === '/b10/broken.html') {
    send(200, 'text/html', '<html><body><main><p>BROKEN_FIXTURE_TEXT');
    return;
  }
  if (path === '/b10/unsupported.bin') {
    send(200, 'application/octet-stream', Buffer.from([0, 1, 2, 3]));
    return;
  }
  if (path === '/b10/slow') {
    setTimeout(
      () => send(200, 'text/html', page('Slow', '<main>SLOW_FIXTURE_TEXT</main>')),
      35_000,
    );
    return;
  }
  if (path === '/b10/large') {
    send(200, 'text/html', `${page('Large', '<main>')}${'x'.repeat(51 * 1024 * 1024)}</main>`);
    return;
  }
  if (path === '/b10/flaky') {
    if ((hits.get(path) ?? 0) === 1) {
      send(503, 'text/plain', 'temporary');
    } else {
      send(200, 'text/html', page('Flaky', '<main>FLAKY_FIXTURE_TEXT</main>'));
    }
    return;
  }
  if (path === '/b10/recursive.html') {
    send(
      200,
      'text/html',
      page(
        'Recursive',
        '<main><p>RECURSIVE_PARENT</p><a href="/b10/recursive-child">child</a></main>',
      ),
    );
    return;
  }
  if (path === '/b10/recursive-child') {
    send(200, 'text/html', page('Child', '<main>RECURSIVE_CHILD_MUST_NOT_BE_REQUESTED</main>'));
    return;
  }
  if (path === '/b10/logs') {
    send(200, 'application/json', JSON.stringify(Object.fromEntries(hits)));
    return;
  }
  send(404, 'text/plain', 'not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`B10 fixture listening on http://127.0.0.1:${port}`);
});
