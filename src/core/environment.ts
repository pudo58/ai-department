import { canonicalJson,sha256 } from './contract.js';
import type { Run,Artifact } from '../shared/types.js';
import type { EnvironmentProbe } from '../shared/execution.js';
export const environmentHash=(run:Run):string=>sha256(canonicalJson({profile:run.configSnapshot,slot:run.selectedSlot}));
export function readEnvironment(run:Run,artifacts:readonly Artifact[]):EnvironmentProbe|undefined{
  const a=artifacts.filter(a=>a.title==='Environment preflight' && a.valid).at(-1);
  if(!a || sha256(a.content)!==a.hash)return;
  try{const p=JSON.parse(a.content) as EnvironmentProbe;return p.schemaVersion===1 && p.configHash===environmentHash(run)?p:undefined;}catch{return;}
}
