export interface ContextPricing {
  kind: 'tiered' | 'flat' | 'unknown';
  scope: 'direct-api' | 'copilot' | 'custom';
  thresholds: number[];
  source: string;
  checkedAt: string | null;
  note: string;
}
export interface ContextPolicyParameters { contextWindow: number; contextWindowMode?: 'shared' | 'input'; maxInputTokens?: number; contextPricing?: ContextPricing }
export function inputCeiling(parameters: ContextPolicyParameters): number;
export function pricingNote(parameters:ContextPolicyParameters):string;
