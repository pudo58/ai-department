// Host-authored adapter: JSON calls only, never a model-supplied shell command or script.
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{isDeepStrictEqual}=require('node:util');
const {createHmac}=require('node:crypto');
const recipe=JSON.parse(fs.readFileSync(0,'utf8'));
const mac=createHmac('sha256',recipe.secret),update=mac.update.bind(mac),digest=mac.digest.bind(mac),stringify=JSON.stringify.bind(JSON),write=process.stdout.write.bind(process.stdout);
// The secret arrives over consumed stdin, never argv/env or a project-readable file.
const emit=result=>{const payload=stringify(result);update(payload);write('\nAIDEPT_REPLAY_RESULT:'+stringify({payload,mac:digest('hex')})+'\n');};
const observations=[],values=new Map(),blocked=new Set(['__proto__','prototype','constructor']);
const safe=(value)=>value===undefined?null:JSON.parse(JSON.stringify(value));
const at=(value,parts)=>{for(const part of parts){if(blocked.has(part))throw Error('Unsafe property');value=value==null?undefined:value[part];}return value;};
const args=value=>{if(!value||typeof value!=='object')return value;if(!Array.isArray(value)&&Object.hasOwn(value,'$ref'))return safe(at(values.get(value.$ref),value.path));if(Array.isArray(value))return value.map(args);return Object.fromEntries(Object.entries(value).map(([k,v])=>{if(blocked.has(k))throw Error('Unsafe argument key');return[k,args(v)];}));};
const environment=error=>['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_ACCESS_DENIED','EACCES','EPERM','ERR_UNKNOWN_FILE_EXTENSION','ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'].includes(error?.code);
(async()=>{
 try{
  const filename=fs.realpathSync(path.resolve(recipe.root,recipe.scenario.module)),root=fs.realpathSync(recipe.root);
  if(!filename.startsWith(root+path.sep))throw Error('Module outside replay clone');
  const exports=await import(pathToFileURL(filename).href),factory=exports[recipe.scenario.factory];
  if(typeof factory!=='function')throw Error('Factory export unavailable');
  const instance=await factory(...args(recipe.scenario.args));
  for(const step of recipe.scenario.steps){
   let value,error;
   try{if(blocked.has(step.method)||typeof instance?.[step.method]!=='function')throw Error('Public method unavailable');value=await instance[step.method](...args(step.args));}catch(e){error=e;}
   if(environment(error))throw error;
   if(!step.expect){if(error)throw error;values.set(step.id,value);observations.push({stepId:step.id,actual:safe(value),actualType:value===undefined?'undefined':typeof value});continue;}
   const expected=step.expect,observed=error?String(error.code??error.name):at(value,expected.path);
   const matched=Object.hasOwn(expected,'throwsCode')?!!error&&observed===expected.throwsCode:!error&&isDeepStrictEqual(observed,expected.equals);
   observations.push({stepId:step.id,actual:safe(observed),actualType:observed===undefined?'undefined':typeof observed,expected:Object.hasOwn(expected,'throwsCode')?expected.throwsCode:expected.equals,matched,...(error?{error:String(error.code??error.message)}:{})});
   if(!matched){emit({status:'reproduced',observations,message:`Sai khác tại ${step.id}; đối chiếu oracle trước khi xác nhận finding.`});return;}
   values.set(step.id,value);
  }
  emit({status:'not_reproduced',observations,message:'Các kết quả khai báo đều khớp trong lần chạy này; không suy thành chứng minh toàn bộ code đúng.'});
 }catch(error){emit({status:'error',observations,message:`Không đủ bằng chứng tái hiện: ${error.code??error.message}`});}
})().then(()=>process.exit(0),error=>{emit({status:'error',observations,message:String(error.message)});process.exit(1);});
