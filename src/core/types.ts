export type ApiType = 'responses' | 'chatCompletions' | 'messages';
export type OfficialProtocol = 'chat-completions' | 'responses' | 'messages';
export type ModelVendor = string;
export interface ProviderConnection { apiType: ApiType; url: string }

export interface ProtocolProfile {
  /** 'unsupported' hides reasoning efforts when the protocol requires non-standard request paths. */
  effortFormat?: OfficialProtocol | 'unsupported';
  effortValues?: Record<string, string | null>;
  adaptiveThinking?: boolean;
  thinkingBudget?: { min: number; max: number };
  modelOptions?: { temperature?: number | null; top_p?: number | null };
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
  releaseDate?: string | null;
  maxInputTokens?: number;
  /** Presentation preset only; the original request ID is never rewritten. */
  aliasOf?: string;
  protocols?: Partial<Record<ApiType, ProtocolProfile>>;
}

export interface ModelDatabase {
  schemaVersion: 1;
  defaults: ModelParameters;
  models: Record<string, ModelParameters>;
}

export interface CatalogSnapshot {
  source: 'models.dev';
  updatedAt: string;
  database: ModelDatabase;
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
  /** Used in unified mode. */
  unified: { apiType: ApiType; url: string };
  endpoints: Record<ApiType, string>;
  /** Explicit per-model protocol in split mode; missing IDs use recommendedProtocol(id). */
  modelProtocols: Record<string, ApiType>;
  enabled: boolean;
  models: ModelConfig[];
}

export interface StudioState {
  version: 1;
  providers: ProviderConfig[];
  catalog?: CatalogSnapshot;
}

export interface DiscoveredModel { id: string; name: string }

export interface ExportedProvider extends ProviderConfig { apiKey?: string }

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  providers: ExportedProvider[];
}
