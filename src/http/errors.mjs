export class ApiError extends Error {
  constructor(status, message, code = 'invalid_request', param = null) {
    super(message);
    Object.assign(this, { status, code, param });
  }
}

export function errorBody(error) {
  return { error: {
    message: error.message || '服务异常',
    type: error.status === 401 ? 'authentication_error' : error.status >= 500 ? 'server_error' : 'invalid_request_error',
    code: error.code || 'bridge_error',
    param: error.param ?? null,
  } };
}

export function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
