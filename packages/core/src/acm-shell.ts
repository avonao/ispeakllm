// Ported from llms-txt/src/acm-shell.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * Unsigned ACM payload builder: the structural AI Conformance Manifest minus
 * its `provenance` envelope. Signing lives in @ispeakllm/sign
 * (`signManifest(shell, key)` adds `provenance`).
 */

import type {
  AiConformanceManifestUnsigned,
  AcmAiDisclosure,
  AcmConsentBlock,
  AcmContentSource,
  AcmIssuer,
  AcmPage,
  AcmPolicies,
  AcmSection,
  AcmVerification,
} from "./types";
import { ACM_SPEC_VERSION } from "./types";
import type { GeneratedOutputs } from "./generate";

export type BuildAcmShellInput = {
  domain: string;
  issuer: AcmIssuer;
  issued_at: string;
  expires_at?: string;
  content_source?: AcmContentSource;
  ai_disclosure: AcmAiDisclosure;
  consent?: AcmConsentBlock;
  policies?: AcmPolicies;
  verification?: AcmVerification;
  sections?: AcmSection[];
  /** Site origin used for each page's `md_url`. Omitted: no `md_url`. */
  origin?: string;
  /** The output of `generate()`. */
  outputs: GeneratedOutputs;
};

/** Build the unsigned ACM shell. Deterministic: same input gives the same JSON (issued_at is caller-controlled). */
export function buildAcmShell(input: BuildAcmShellInput): AiConformanceManifestUnsigned {
  const origin = input.origin?.replace(/\/$/, "");
  const pages: AcmPage[] = input.outputs.pages.map((p) => ({
    path: p.ref.path,
    title: p.ref.title,
    summary: p.ref.summary,
    section: p.ref.section,
    priority: p.ref.priority,
    last_modified: p.ref.lastModified,
    md_url: origin ? `${origin}${p.mdPath}` : undefined,
    content_hash: p.hash,
  }));
  for (const page of pages) {
    for (const k of Object.keys(page) as (keyof AcmPage)[]) if (page[k] === undefined) delete page[k];
  }

  const shell: AiConformanceManifestUnsigned = {
    spec_version: ACM_SPEC_VERSION,
    domain: input.domain,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    content_source: input.content_source ?? "source-connected",
    issuer: input.issuer,
    ai_disclosure: input.ai_disclosure,
    consent: input.consent,
    content_map: { sections: input.sections, pages },
    policies: input.policies,
    verification: input.verification,
  };
  for (const k of Object.keys(shell) as (keyof AiConformanceManifestUnsigned)[]) {
    if (shell[k] === undefined) delete shell[k];
  }
  if (shell.content_map.sections === undefined) delete shell.content_map.sections;
  return shell;
}
