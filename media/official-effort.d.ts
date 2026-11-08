import type { ApiType, ModelParameters } from '../src/core/types';
export interface EffortProjection {
  levels: string[];
  nativeLevels: string[];
  mapping: Record<string, string>;
  rejected: Array<{level: string; field: string}>;
  format?: 'chat-completions' | 'responses' | 'messages';
}
export function projectEfforts(parameters: ModelParameters, apiType: ApiType): EffortProjection;
