// -----------------------------------------------------------------------------
// The real transport (node:http), against a server on the loopback interface:
// headers, body, size cap, timeout. Nothing leaves the machine.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MAX_BODY_BYTES, httpRequest } from '../src/redfish/http.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('sends the headers and reads the answer', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${req.method} ${req.url} ${req.headers.authorization}`);
    },
    async (base) => {
      const response = await httpRequest(`${base}/redfish/v1/`, {
        headers: { authorization: 'Basic OmtleQ==' },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'text/plain');
      assert.equal(response.body, 'GET /redfish/v1/ Basic OmtleQ==');
    },
  );
});

test('an answer larger than the cap is refused', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(MAX_BODY_BYTES + 1024, 'a'));
    },
    async (base) => {
      await assert.rejects(httpRequest(`${base}/redfish/v1/`), /too large/);
    },
  );
});

test('a server that does not answer in time is a timeout', async () => {
  await withServer(
    () => {
      // Never answers.
    },
    async (base) => {
      await assert.rejects(httpRequest(`${base}/redfish/v1/`, { timeoutMs: 100 }), (err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        return true;
      });
    },
  );
});

test('a closed port is refused', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(httpRequest(`http://127.0.0.1:${port}/redfish/v1/`), (err) => {
    assert.equal(err.code, 'ECONNREFUSED');
    return true;
  });
});

test('a POST sends its JSON body with its length', async () => {
  await withServer(
    (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(204, {
          'x-seen': `${req.method} ${req.headers['content-type']} ${req.headers['content-length']}`,
        });
        res.end();
        received.push(Buffer.concat(chunks).toString('utf8'));
      });
    },
    async (base) => {
      const response = await httpRequest(
        `${base}/redfish/v1/Systems/1/Actions/ComputerSystem.Reset`,
        {
          method: 'POST',
          body: '{"ResetType":"On"}',
        },
      );
      assert.equal(response.status, 204);
      assert.equal(response.headers['x-seen'], 'POST application/json 18');
      assert.deepEqual(received, ['{"ResetType":"On"}']);
    },
  );
});

const received = [];
