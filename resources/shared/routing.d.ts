export type ApiType = 'responses' | 'chatCompletions' | 'messages';
export type ModelVendor = string;
export interface ModelRules { schemaVersion: 1; fallback: string; vendors: Array<VendorDefinition & {pattern?:string}>; exclusions: Array<{kind:'image'|'video'|'non-chat';pattern:string}>; models: Record<string,{vendor?:string;protocol?:ApiType;excludedKind?:'image'|'video'|'non-chat'}> }
export function configure(rules?: ModelRules): void;
export function modelRules(): ModelRules;
export interface VendorDefinition { id: ModelVendor; name: string; protocol: ApiType }
export const apiTypes: readonly ApiType[];
export const vendors: readonly VendorDefinition[];
export function vendorOf(id: string): ModelVendor;
export function excludedKind(id: string): 'image' | 'video' | 'non-chat' | null;
export function defaultProtocols(): Record<ModelVendor, ApiType>;
export type RoutingMode = 'unified' | 'split';
export interface RoutingInput { url?: string; apiType?: ApiType; routingMode?:RoutingMode; unified?:{apiType:ApiType;url:string}; endpoints?: Partial<Record<ApiType,string>>; modelProtocols?:Record<string,ApiType>; vendorProtocols?: Partial<Record<ModelVendor,ApiType>>; zeroDataRetentionEnabled?: boolean; models?:readonly {id:string}[] }
export interface RoutingConfig { routingMode:RoutingMode;unified:{apiType:ApiType;url:string};endpoints:Record<ApiType,string>;modelProtocols:Record<string,ApiType> }
export function recommendedProtocol(modelId:string):ApiType;
export function normalizeRouting(provider: RoutingInput): RoutingConfig;
export function routeForModel(provider: RoutingInput, modelId: string, routing?: RoutingConfig): {apiType:ApiType;url:string;zeroDataRetentionEnabled:boolean};
export function protocolLists<T extends {id:string}>(provider:RoutingInput & {models:readonly T[]}):Array<{apiType:ApiType;models:T[]}>;
export function assignModels(provider:RoutingInput,ids:readonly string[],apiType:ApiType):Record<string,ApiType>;
export function groups<T extends {id:string}>(models:readonly T[]): Array<VendorDefinition & {models:T[]}>;
export function replaceModels<T extends {id:string;name:string;discoveredName:string;overrides:object}>(previous:readonly T[],discovered:readonly {id:string;name:string}[]): T[];
