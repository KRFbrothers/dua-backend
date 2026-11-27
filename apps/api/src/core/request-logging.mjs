import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const context = new AsyncLocalStorage();
const routes = new Set(['/api/chat', '/api/connectors/github', '/api/build/pr']);
const stages = new Set(['repository_list', 'repository_load', 'repository_tree', 'file_read', 'repository_search', 'proposal_creation', 'pr_submission']);
const statusOf = value => Number.isInteger(value?.status) && value.status >= 100 && value.status <= 599 ? value.status : undefined;

/** The server-generated request id for the current async context, or null outside a logged request. */
export function currentRequestId() {
  return context.getStore()?.id || null;
}

// Deliberately no arbitrary metadata, error text, URLs, headers, bodies or model/tool arguments.
function emit(event, { stage, outcome, started, status } = {}) {
  const state = context.getStore();
  // A request-id-only context (withRequestId) has no sink: it carries the id, not a log line.
  if (!state || typeof state.write !== 'function') return;
  const record = {
    source: 'dua-github', requestId: state.id, route: state.route, event,
    ...(stage ? { stage } : {}), ...(outcome ? { outcome } : {}),
    ...(started === undefined ? {} : { durationMs: Math.max(0, Math.round(performance.now() - started)) }),
    ...(status === undefined ? {} : { status }),
  };
  // Observability must never prevent an authorized read, proposal or PR from completing.
  try { state.write(JSON.stringify(record)); } catch { /* Hosting log sink unavailable. */ }
}

/** One fresh server-generated ID per supported request, isolated across concurrent async work. */
export function withRequestLog(request, operation, { logWriter = line => console.info(line) } = {}) {
  const route = new URL(request.url).pathname;
  if (!routes.has(route)) return operation();
  // Reuse the id withRequestId already minted for this request, so the log line and the
  // X-Request-Id header a client quotes are the same value.
  const id = currentRequestId() || randomUUID();
  return context.run({ id, route, write: logWriter }, async () => {
    const started = performance.now();
    emit('request.started');
    try {
      const response = await operation();
      // This is response creation, not stream completion, durable reply saving or PR merging.
      emit('request.response', { started, status: statusOf(response) });
      return response;
    } catch (error) {
      emit('request.failed', { started, status: statusOf(error) });
      throw error;
    }
  });
}

/**
 * Gives every request a server-generated id without writing a log line.
 *
 * Phase 3 item 8.4: before this, only /api/chat, /api/connectors/github and /api/build/pr
 * had a request id. The other routes had none, so a 500 could not be tied to a request.
 *
 * This is deliberately separate from withRequestLog: that one owns the GitHub stage log
 * schema and must keep emitting nothing for unrelated routes. This one only puts an id in
 * the async context and echoes it back as X-Request-Id, so a client can quote it.
 */
export function withRequestId(request, operation, { header = 'X-Request-Id' } = {}) {
  // Always server-generated. A client-supplied x-request-id is never adopted: it would let
  // a caller forge or collide ids in the log, and the existing GitHub log test asserts this.
  const id = randomUUID();
  return context.run({ id, route: new URL(request.url).pathname }, async () => {
    const response = await operation();
    try { if (response?.headers && !response.headers.has(header)) response.headers.set(header, id); } catch { /* immutable headers */ }
    return response;
  });
}

/** Decorates existing operations without changing their arguments, return type, errors or permissions. */
export function loggedStage(stage, operation, classify = () => 'success') {
  if (!stages.has(stage)) throw new TypeError('Unknown logging stage');
  return function (...args) {
    if (!context.getStore()) return operation.apply(this, args);
    const started = performance.now();
    emit('stage.started', { stage });
    const finished = result => {
      emit('stage.finished', { stage, started, outcome: classify(result) === 'refused' ? 'refused' : 'success' });
      return result;
    };
    const failed = error => {
      emit('stage.finished', { stage, started, outcome: 'error', status: statusOf(error) });
      throw error;
    };
    try {
      const result = operation.apply(this, args);
      return result instanceof Promise ? result.then(finished, failed) : finished(result);
    } catch (error) { return failed(error); }
  };
}
