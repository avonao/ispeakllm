// Ported from llms-txt/src/types.ts (goplainly-v6-2026-11-10-current-dormant)
/**
 * @ispeakllm/core: wire types.
 *
 * The ACM types are a local mirror of spec/acm/acm.schema.json so the package
 * keeps zero runtime dependencies (it never imports @ispeakllm/sign).
 */

/** ACM spec version this engine targets. */
export const ACM_SPEC_VERSION = "1.0" as const;

/** Article-50-aligned interaction categories. */
export type AcmAiSystemCategory =
  | "conversational_ai"
  | "content_generation"
  | "synthetic_media"
  | "recommendation"
  | "personalization"
  | "emotion_recognition"
  | "biometric_categorization"
  | "other";

/** `managed-crawl` is the explicitly-degraded fallback. */
export type AcmContentSource = "source-connected" | "managed-crawl";

export type AcmAnchorStatus = "pending" | "settled";

/** Page reference returned by `ContentSource.list()`. */
export type PageRef = {
  /** Site-relative path, e.g. `/about` or `/posts/hello`. MUST start with `/`. */
  path: string;
  /** ISO-8601 timestamp of last modification (used for `Last-Modified`). */
  lastModified?: string;
  /** Display title: surfaces in `llms.txt` and the per-page header. */
  title: string;
  /** One-line summary: surfaces in `llms.txt` and the manifest content map. */
  summary?: string;
  /** Section id (groups `llms.txt` rows). */
  section?: string;
  /** Higher = more prominent in the curated index (default 0). */
  priority?: number;
  /** Listed under the reserved `Optional` section (llmstxt.org: may be skipped
   *  when a shorter context is needed). */
  optional?: boolean;
  /** Audiences this page is for (e.g. `["developers"]`). Absent = everyone. */
  audience?: string[];
};

/** Canonical content of a page (markdown body + frontmatter). */
export type PageContent = {
  ref: PageRef;
  /** Markdown body (no frontmatter). */
  body: string;
  frontmatter?: Record<string, unknown>;
};

/** The adapter interface: the only content ingestion path (source-first,
 *  never HTML scraping; the html-md package is the explicit fallback). */
export interface ContentSource {
  list(): Promise<PageRef[]>;
  load(ref: PageRef): Promise<PageContent>;
  /** Optional: dynamic sources call back on writes. */
  watch?(cb: (ref: PageRef) => void): void;
}

/** Curated index section (groups `llms.txt` rows). */
export type AcmSection = {
  id: string;
  title: string;
  priority?: number;
};

export type AcmPage = {
  path: string;
  title: string;
  summary?: string;
  section?: string;
  priority?: number;
  last_modified?: string;
  md_url?: string;
  content_hash?: string;
};

export type AcmContentMap = {
  sections?: AcmSection[];
  pages: AcmPage[];
};

export type AcmAiSystem = {
  id: string;
  name?: string;
  category: AcmAiSystemCategory;
  synthetic_media?: boolean;
  purpose: string;
  provider?: string;
  user_facing_disclosure?: string;
  human_oversight?: string;
  data_handling?: string;
  high_risk?: boolean;
};

export type AcmAiDisclosure = {
  summary?: string;
  systems: AcmAiSystem[];
};

export type AcmConsentBlock = {
  config_ref?: string;
  categories?: string[];
  framework?: string;
};

export type AcmIssuer = {
  name: string;
  legal_entity?: string;
  contact?: string;
  jurisdiction?: string;
};

export type AcmPolicies = {
  privacy?: string;
  ai_policy?: string;
  terms?: string;
};

export type AcmVerification = {
  endpoint?: string;
  jwks_uri?: string;
  instructions?: string;
};

export type AcmProvenance = {
  algorithm: "Ed25519";
  canonicalization: "JCS/RFC8785";
  signed_at: string;
  public_key?: string;
  key_ref?: string;
  signature: string;
  anchor?: {
    attestation_id?: string;
    status?: AcmAnchorStatus;
    txid?: string;
    block_height?: number;
    merkle_proof_ref?: string;
    anchored_at?: string;
  };
};

export type AiConformanceManifest = {
  spec_version: typeof ACM_SPEC_VERSION;
  domain: string;
  issued_at: string;
  expires_at?: string;
  content_source?: AcmContentSource;
  issuer: AcmIssuer;
  ai_disclosure: AcmAiDisclosure;
  consent?: AcmConsentBlock;
  content_map: AcmContentMap;
  policies?: AcmPolicies;
  verification?: AcmVerification;
  provenance: AcmProvenance;
};

/** The unsigned shell this package builds. Signing lives in @ispeakllm/sign. */
export type AiConformanceManifestUnsigned = Omit<AiConformanceManifest, "provenance">;
