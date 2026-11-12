export type ApiType = 'responses' | 'chatCompletions' | 'messages';
export type OfficialProtocol = 'chat-completions' | 'responses' | 'messages';
export type RoutingMode = 'unified' | 'split';

export interface ProtocolProfile {
  effortFormat?: OfficialProtocol | 'unsupported';
  adaptiveThinking?: boolean;
  thinkingBudget?: { min: number; max: number };
  modelOptions?: { temperature?: number | null; top_p?: number | null };
}

export interface ModelParameters {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  vision: boolean;
  thinking: boolean;
  supportsReasoningEffort: string[];
  releaseDate?: string;
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

export type ParameterOverrides = Partial<Pick<
  ModelParameters,
  'contextWindow' | 'maxOutputTokens' | 'toolCalling' | 'vision' | 'thinking' | 'supportsReasoningEffort'
>>;

export interface ModelConfig {
  id: string;
  name: string;
  overrides: ParameterOverrides;
  reasoningEffort?: string;
}

export interface RoutingHint {
  routingMode: RoutingMode;
  unified: { apiType: ApiType; url: string };
  endpoints: Record<ApiType, string>;
}

export interface ProviderConfig extends RoutingHint {
  id: string;
  name: string;
  modelProtocols: Record<string, ApiType>;
  models: ModelConfig[];
}

export interface ProviderView extends ProviderConfig {
  hasKey: boolean;
}

export interface UiState {
  providers: ProviderView[];
  database: ModelDatabase;
}

export interface DiscoveredModel {
  id: string;
  name: string;
}

export interface ExportedProvider extends ProviderConfig {
  apiKey?: string;
}

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  providers: ExportedProvider[];
}

export interface OfficialModel {
  id: string;
  name: string;
  url: string;
  apiType: OfficialProtocol;
  toolCalling: boolean;
  vision: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  thinking?: true;
  adaptiveThinking?: boolean;
  minThinkingBudget?: number;
  maxThinkingBudget?: number;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: OfficialProtocol;
  defaultReasoningEffort?: string;
  modelOptions?: { temperature?: number | null; top_p?: number | null };
}

export interface OfficialGroup {
  name: string;
  vendor: 'customendpoint';
  byokStudioId: string;
  apiKey?: string;
  models: OfficialModel[];
  settings?: Record<string, Record<string, unknown>>;
}
