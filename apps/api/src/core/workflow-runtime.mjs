import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { identityConfig, createWorkflowIdentity } from './workflow-identity.mjs';
import { executionDb, WorkflowError, requireEnabled } from './workflow-execution.mjs';
import { runWorkerOnce } from './workflow-worker.mjs';
import { startHeartbeat, drainWorker } from './worker-health.mjs';
import { startTaskReaper, reaperEnabled } from './task-reaper.mjs';

export async function runWorkflowRuntime({ env = process.env, fetcher = fetch, signal, log = event => console.info(JSON.stringify({ source: 'dua-workflow', event })) }) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new WorkflowError('Worker requires Node 24 or newer.');
  const { owner } = identityConfig(env);
  const engine = new URL(env.DUA_ENGINE_URL);
  if (engine.protocol !== 'https:' || engine.pathname !== '/' || engine.username || engine.password || engine.search || engine.hash) throw new WorkflowError('Invalid worker engine URL.');
  const identity = createWorkflowIdentity({ env, fetcher });
  const recover = async (sig) => {
    const session = await identity.getOwner(env, fetcher, sig);
    if (session.user.id !== owner) throw new WorkflowError('Worker session does not belong to its configured owner.', 403);
    await executionDb('rpc/dua_workflow_recover', { env, fetcher, signal: sig, token: session.token, body: { p_owner: session.user.id } });
  };
  // Recovery waits for a verified owner session; it never starts work.
  await recover(signal);
  log('startup_configured');

  // Phase 3 items 4.1 to 4.4: register this worker and keep its heartbeat fresh, so a
  // dead worker is visible instead of only being noticed on the next claim attempt.
  // A stable id per process, not per run: the registry row must survive a claim loop.
  const workerId = String(env.DUA_WORKER_ID || '').trim() || randomUUID();
  const stopHeartbeat = startHeartbeat({
    env, fetcher, workerId, kind: 'workflow',
    version: String(env.DUA_BUILD_VERSION || ''), capacity: 1,
    log: (event, detail) => log(event, detail),
  });
  log('worker_registered', { workerId });

  // Phase 3 item 2.1: the background reaper. Opt in per deployment, because only one
  // process should sweep, and a Cloud Run instance that scales to zero must not be it.
  const stopReaper = reaperEnabled(env)
    ? startTaskReaper({ env, fetcher, log: (event, detail) => log(event, detail) })
    : () => {};
  if (reaperEnabled(env)) log('reaper_started');

  const recoveryStop = new AbortController();
  const recoverySignal = AbortSignal.any([signal, recoveryStop.signal]);
  const recovery = (async () => {
    while (!recoverySignal.aborted) {
      try {
        await delay(10000, undefined, { signal: recoverySignal });
        await recover(recoverySignal);
      } catch { if (!recoverySignal.aborted) log('recovery_unavailable'); }
    }
  })();
  try {
    while (!signal.aborted) {
      try {
        requireEnabled(env);
        await runWorkerOnce({ env, fetcher, signal, getOwner: identity.getOwner });
      } catch { if (!signal.aborted) log('execution_or_identity_unavailable'); }
      try { await delay(3000, undefined, { signal }); } catch { break; }
    }
  } finally {
    // Drain first so no new claim is taken, then stop the loops. In-flight work is
    // allowed to finish: the heartbeat stops, but the claim loop exits on its own signal.
    await drainWorker({ env, fetcher, workerId }).catch(() => null);
    stopReaper();
    stopHeartbeat();
    recoveryStop.abort();
    await recovery;
    log('stopped');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  process.on('SIGTERM', () => stop.abort()); process.on('SIGINT', () => stop.abort());
  try { await runWorkflowRuntime({ signal: stop.signal }); }
  catch { console.error('Workflow startup failed. Check the runtime migration, owner identity and configuration.'); process.exitCode = 1; }
}
