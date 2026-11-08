export type ApiType = 'responses' | 'chatCompletions' | 'messages';
export type ModelVendor = string;
export interface ProviderConnection { apiType: ApiType; url: string; zeroDataRetentionEnabled: boolean }

export interface ContextPriceBand {
  /** null means the last, open-ended band; boundaries are inclusive. */
  inputUpTo: number | null;
  outputUpTo?: number | null;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export interface ContextPricing {
  kind: 'tiered' | 'flat' | 'unknown';
  scope: 'direct-api' | 'copilot' | 'custom';
  /** Inclusive input-token ceilings of the lower price bands. */
  thresholds: number[];
  source: string;
  checkedAt: string | null;
  note: string;
  rates?: { currency: 'USD' | 'CNY'; perTokens: 1000000; bands: ContextPriceBand[] };
}

export type ParameterValue = string | number | boolean | null | ParameterValue[] | { [key: string]: ParameterValue };
export interface ModelApiProfile {
  /** Omitted uses the protocol's standard field; null declares a toggle/budget-only profile. */
  effortPath?: string[] | null;
  /** Explicit aliases; null suppresses the effort field for that selection. */
  effortValues?: Record<string, string | null>;
  modePath?: string[];
  enabledValue?: string | number | boolean | null;
  disabledValue?: string | number | boolean | null;
  /** Applied without an effort selection only when the model declares thinking support. */
  defaultMode?: string | number | boolean | null;
  /** With modePath, disabled selections omit effort unless effortValues explicitly maps them. */
  disabledEfforts?: string[];
  budgetPath?: string[];
  budget?: { min: number; max: number; default: number };
  /** Only declared mappings change the default budget; effort labels have no implied token counts. */
  budgetByEffort?: Record<string, number>;
  /** Whether forced tool use is supported while thinking is enabled. */
  supportsForcedTools?: boolean;
  allowUnsignedThinking?: boolean;
  /** Whitelisted paths relative to an individual tool call, containing opaque string fragments. */
  toolCallMetadataPaths?: string[][];
  /** Additional verified request parameters; reserved request and credential fields are rejected. */
  parameters?: Record<string, ParameterValue>;
}
export interface ReasoningControls {
  protocols?: Partial<Record<ApiType, ModelApiProfile>>;
  note: string;
}

export interface ModelParameters {
  name: string;
  contextWindow: number;
  /** Whether the documented window is a shared pool or an independent input quota. */
  contextWindowMode?: 'shared' | 'input';
  maxOutputTokens: number;
  /** Default generation budget; separate from the documented physical output ceiling. */
  defaultOutputTokens?: number;
  toolCalling: boolean;
  vision: boolean;
  thinking: boolean;
  supportsReasoningEffort: string[];
  source: string;
  verifiedAt: string | null;
  releaseDate?: string | null;
  maxInputTokens?: number;
  contextPricing?: ContextPricing;
  /** Presentation preset only; the original request ID is never rewritten. */
  aliasOf?: string;
  reasoningControls?: ReasoningControls;
  chatCompletionOptions?: {
    maxTokensField: 'max_tokens' | 'max_completion_tokens';
    maxOutputTokens?: number;
    includeUsage: boolean;
    store?: boolean;
  };
}

export interface ModelDatabase {
  schemaVersion: 1;
  defaults: ModelParameters;
  models: Record<string, ModelParameters>;
}

export type ParameterOverrides = Partial<Pick<ModelParameters, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens' | 'defaultOutputTokens' | 'toolCalling' | 'vision' | 'thinking' | 'supportsReasoningEffort'>>;

export interface ModelConfig {
  id: string;
  name: string;
  discoveredName: string;
  overrides: ParameterOverrides;
  reasoningEffort?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  routingMode: 'unified' | 'split';
  unified: { apiType: ApiType; url: string };
  endpoints: Record<ApiType, string>;
  modelProtocols: Record<string, ApiType>;
  enabled: boolean;
  zeroDataRetentionEnabled: boolean;
  models: ModelConfig[];
}

export interface StudioState {
  version: 1;
  providers: ProviderConfig[];
  database: ModelDatabase;
  appliedCatalogUpdates?: string[];
}

export interface DiscoveredModel { id: string; name: string }
