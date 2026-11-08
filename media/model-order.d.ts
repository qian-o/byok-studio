export function validDate(value: unknown): value is string;
export function releaseDate(model: {id: string}, records: Record<string, {releaseDate?: string | null}>): string | null;
