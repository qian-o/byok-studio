export type ApiType = 'responses' | 'chatCompletions' | 'messages';
export type RoutingMode = 'unified' | 'split';

export interface PresetRecord {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  vision: boolean;
  thinking: boolean;
  supportsReasoningEffort: string[];
  releaseDate?: string;
  protocols?: Partial<Record<ApiType, {
    effortFormat?: 'chat-completions' | 'responses' | 'messages' | 'unsupported';
    adaptiveThinking?: boolean;
    thinkingBudget?: { min: number; max: number };
    modelOptions?: { temperature?: number | null; top_p?: number | null };
  }>>;
}

export interface PresetDatabase {
  schemaVersion: 1;
  defaults: PresetRecord;
  models: Record<string, PresetRecord>;
}

export interface RoutingInput {
  url?: string;
  apiType?: ApiType;
  routingMode?: RoutingMode;
  unified?: { apiType: ApiType; url: string };
  endpoints?: Partial<Record<ApiType, string>>;
  modelProtocols?: Record<string, ApiType>;
  models?: readonly { id: string }[];
}

export interface RoutingConfig {
  routingMode: RoutingMode;
  unified: { apiType: ApiType; url: string };
  endpoints: Record<ApiType, string>;
  modelProtocols: Record<string, ApiType>;
}

export const apiTypes: readonly ApiType[];
export function isExcludedModel(id: string): boolean;
export function recommendedProtocol(modelId: string): ApiType;
export function validDate(value: unknown): value is string;
export function lookupPreset(database: PresetDatabase, id: string): PresetRecord;
export function defaultEfforts(preset: PresetRecord, apiType?: ApiType): string[];
export function baseParametersForProtocol(database: PresetDatabase, id: string, apiType?: ApiType): PresetRecord;
export function formatModelName(id: string): string;
export function displayModelName(database: PresetDatabase, model: { id: string; name?: string }): string;
export function normalizeRouting(provider?: RoutingInput): RoutingConfig;
export function routeForModel(provider: RoutingInput, modelId: string, routing?: RoutingConfig): { apiType: ApiType; url: string };
export function protocolLists<T extends { id: string }>(provider: RoutingInput & { models: readonly T[] }): Array<{ apiType: ApiType; models: T[] }>;
export function assignModels(provider: RoutingInput, ids: readonly string[], apiType: ApiType): Record<string, ApiType>;
export function replaceModels<T extends { id: string; name: string; overrides: object; reasoningEffort?: string }>(
  previous: readonly T[],
  discovered: readonly { id: string; name: string }[]
): Array<{ id: string; name: string; overrides: Record<string, unknown>; reasoningEffort?: string }>;

