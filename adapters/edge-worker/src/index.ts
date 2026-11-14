/**
 * Cloudflare Worker adapter. Put it on a route in front of an existing site (any host):
 * agent requests are answered from the bundle; everything else is proxied to ISPEAKLLM_UPSTREAM
 * (or to the zone's origin with `fetch(request)` when no upstream is set) and only gets headers added.
 *
 * Bindings (all optional):
 *   ISPEAKLLM_UPSTREAM  origin to proxy human traffic to, e.g. https://origin.example.com
 *   ISPEAKLLM_IP_SALT   secret (16+ chars); enables the graded fetch log (IPs are only stored hashed)
 *   FETCH_LOG           KV namespace; each agent fetch is stored as one `ispeakllm.fetch/1` NDJSON record
 */

import { createAgentHandler, type Bundle, type FetchEvent, type ServeOptions } from "@ispeakllm/serve";
import { serializeFetchRecord } from "@ispeakllm/agents";

export type KvLike = { put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> };
export type WorkerEnv = { ISPEAKLLM_UPSTREAM?: string; ISPEAKLLM_IP_SALT?: string; FETCH_LOG?: KvLike };
export type WorkerContext = { waitUntil(p: Promise<unknown>): void };

export type WorkerOptions = Omit<ServeOptions, "bundle" | "upstream" | "fetchLog" | "onFetch"> & {
  /** Days a fetch record is kept in KV (default 30). */
  retentionDays?: number;
  onFetch?: (e: FetchEvent) => void | Promise<void>;
};

export function createWorker(bundle: Bundle, options: WorkerOptions = {}) {
  return {
    async fetch(request: Request, env: WorkerEnv = {}, ctx?: WorkerContext): Promise<Response> {
      const pending: Promise<unknown>[] = [];
      const handler = createAgentHandler({
        ...options,
        bundle,
        upstream: env.ISPEAKLLM_UPSTREAM ?? ((req: Request) => fetch(req)),
        ...(env.ISPEAKLLM_IP_SALT ? { fetchLog: { ipSalt: env.ISPEAKLLM_IP_SALT } } : {}),
        onFetch: async (e) => {
          if (e.record && env.FETCH_LOG) {
            const day = e.record.fetchedAtIso.slice(0, 10);
            pending.push(env.FETCH_LOG.put(`fetch/${day}/${e.record.fetchId}`, serializeFetchRecord(e.record), { expirationTtl: (options.retentionDays ?? 30) * 86400 }));
          }
          await options.onFetch?.(e);
        },
      });
      const res = await handler.fetch(request);
      if (pending.length) {
        const all = Promise.allSettled(pending);
        if (ctx) ctx.waitUntil(all);
        else await all;
      }
      return res;
    },
  };
}
