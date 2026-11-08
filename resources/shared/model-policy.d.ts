import type { ApiType, ModelParameters } from '../../src/core/types';
export function validDate(value: unknown): value is string;
export function releaseDate(model: {id: string}, records: Record<string, {releaseDate?: string | null}>): string | null;
type ContextParameters = Pick<ModelParameters, 'contextWindow' | 'contextWindowMode' | 'maxInputTokens' | 'contextPricing'>;
export function inputCeiling(parameters: ContextParameters): number;
export function pricingNote(parameters: ContextParameters): string;
export interface EffortProjection {
  levels: string[];
  nativeLevels: string[];
  mapping: Record<string, string>;
  rejected: Array<{level: string; field: string}>;
  format?: 'chat-completions' | 'responses' | 'messages';
}
export function projectEfforts(parameters: ModelParameters, apiType: ApiType): EffortProjection;
