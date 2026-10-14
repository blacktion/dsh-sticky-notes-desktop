/**
 * Minimal web helpers for the plugin's browser-facing JSON routes.
 *
 * Raw web-server routes do NOT inherit the Connection authentication fence, so
 * every route this plugin registers is wrapped in `authenticatedWebRoutes`.
 *
 * Both helpers are defensive on purpose: DSH's fail-loud policy makes a
 * rejected promise from an HTTP handler an application-level failure, so
 * nothing in here is allowed to leave a request dangling or unhandled.
 */

export class RequestBodyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Drain at most `maxBytes` and parse a JSON object body.
 * Always removes its listeners, including on the error paths — leaving them
 * attached is what makes a keep-alive connection hang.
 */
export async function readJsonRequest(req, maxBytes = 32_000_000) {
  const raw = await new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      if (error) {
        chunks.length = 0;
        req.once('error', () => {});
        req.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const onData = (chunk) => {
      try {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += part.length;
        if (size > maxBytes) finish(new RequestBodyError('request body is too large', 413));
        else chunks.push(part);
      } catch {
        finish(new RequestBodyError('invalid request body', 400));
      }
    };
    const onEnd = () => finish();
    const onAborted = () => finish(new RequestBodyError('request body was aborted', 400));
    const onError = () => finish(new RequestBodyError('invalid request body', 400));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });

  let value;
  try {
    value = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    throw new RequestBodyError('invalid JSON', 400);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestBodyError('body must be an object', 400);
  }
  return value;
}

export function sendJson(res, status, value) {
  let body;
  try {
    body = JSON.stringify(value ?? null);
  } catch {
    body = JSON.stringify({ error: 'response is not serializable' });
    status = 500;
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}

/** Send raw bytes with an explicit content type. */
export function sendBytes(res, status, contentType, bytes) {
  try {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': bytes.length,
      'cache-control': 'no-store',
    });
    res.end(bytes);
  } catch {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read a JSON object body, mapping a rejection to a response so a handler can
 * simply `return` when it receives `null`.
 */
export async function readJsonBody(req, res, maxBytes) {
  try {
    return await readJsonRequest(req, maxBytes);
  } catch (error) {
    sendJson(res, error instanceof RequestBodyError ? error.status : 400, {
      error: error instanceof Error ? error.message : 'invalid request body',
    });
    return null;
  }
}

/** Wrap a web server so every route passes the Connection trust gate first. */
export function authenticatedWebRoutes(server, connection) {
  return {
    register(route) {
      return server.register({
        ...route,
        async handler(req, res) {
          try {
            let gate;
            try {
              gate = connection();
            } catch {
              gate = undefined;
            }
            const rejection = gate === undefined ? 503 : gate.requestRejection(req);
            if (rejection !== undefined) {
              sendJson(res, rejection, {
                error:
                  rejection === 503 ? 'authentication unavailable' : rejection === 401 ? 'unauthorized' : 'forbidden',
              });
              return;
            }
            await route.handler(req, res);
          } catch (error) {
            // A handler failure must become a response, never a rejection: an
            // unhandled rejection here would take down the whole host process.
            if (!res.headersSent) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
            } else {
              try {
                res.end();
              } catch {
                /* ignore */
              }
            }
          }
        },
      });
    },
  };
}
