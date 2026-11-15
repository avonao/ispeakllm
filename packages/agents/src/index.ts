export * from "./structured-fields";
export {
  fieldValue,
  isEd25519Jwk,
  messageFromRequest,
  parseSignatures,
  signatureBase,
  verifyBase,
  verifySignature,
} from "./signatures";
export type { Ed25519Jwk, ParsedSignature, Result, SigError, SignatureParams, SignedMessage } from "./signatures";
export {
  DIRECTORY_PATH,
  IDENTITY_GRADES,
  KeyResolutionError,
  WEB_BOT_AUTH_TAG,
  coveredSignatureAgent,
  ed25519Thumbprint,
  verifyWebBotAuth,
} from "./web-bot-auth";
export type { IdentityGrade, KeyResolver, KeySource, ResolvedKey, VerifyOptions, WebBotAuthVerdict } from "./web-bot-auth";
export { MemoryDirectoryCache, createDirectoryKeyResolver } from "./directory";
export type { DirectoryCache, DirectoryEntry, DirectoryFetchResult, DirectoryFetcher, DirectoryResolverOptions } from "./directory";
export { cidrContains, ipInAnyCidr, normaliseIp, parseCidr, parseIp, toArpaName } from "./cidr";
export type { Cidr, ParsedIp } from "./cidr";
export { saltedIpHash } from "./ip-hash";
export { KNOWN_AGENTS, REGISTRY_VERIFIED_AT, agentBySignatureOrigin, matchAgentByUserAgent } from "./registry";
export type { AgentKind, KnownAgent } from "./registry";
export { createDohResolver, forwardConfirmedReverse } from "./rdns";
export type { DnsResolver, DohFetch, ReverseDnsResult } from "./rdns";
export { NETWORK_EVIDENCE, gradeRequest } from "./grade";
export type { GradeDeps, GradeInput, Identity, IpRangeProvider, NetworkEvidence } from "./grade";
export {
  FETCH_LOG_SCHEMA,
  attributedOperator,
  attributionGap,
  buildFetchRecord,
  detectDrift,
  driftHistory,
  holdersOfStaleVersions,
  isAttributable,
  parseFetchLog,
  parseFetchRecord,
  serializeFetchRecord,
} from "./fetch-log";
export type { BuildFetchRecordInput, DriftFinding, FetchLogRecord, ParseResult } from "./fetch-log";
