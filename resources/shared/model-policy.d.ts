import type { ApiType, ModelParameters, OfficialProtocol } from '../../src/core/types';
export function validDate(value: unknown): value is string;
type ContextParameters = Pick<ModelParameters, 'contextWindow' | 'contextWindowMode' | 'maxInputTokens'>;
export function inputCeiling(parameters: ContextParameters): number;
export interface EffortProjection {
  levels: string[];
  nativeLevels: string[];
  mapping: Record<string, string>;
  rejected: Array<{level: string; field: string}>;
  format?: OfficialProtocol;
}
export function projectEfforts(parameters: ModelParameters, apiType: ApiType): EffortProjection;
