import type { Oracle } from './quality.js';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** JSON arguments may reference a preceding result with {$ref:"S-1",path:["token"]}. */
export interface FindingReproduction {
  schemaVersion: 1; adapter: 'node-api'; module: string; factory: string; args: JsonValue[];
  steps: { id: string; method: string; args: JsonValue[]; expect?: { path: string[]; equals?: JsonValue; throwsCode?: string } }[];
  oracle: Oracle;
}
export interface FindingReplay {
  schemaVersion: 1; source: 'runner'; findingId: string; checkpoint: string; contractVersion: number; slot: 'A' | 'B';
  configHash: string; scenarioHash: string; status: 'in_progress' | 'reproduced' | 'not_reproduced' | 'unsupported' | 'error' | 'timeout' | 'interrupted';
  startedAt: string; endedAt?: string; durationMs: number; message: string;
  oracle?: Oracle;
  observations: { stepId: string; actual?: JsonValue; actualType?: string; expected?: JsonValue; matched?: boolean; error?: string }[];
}
