let worker=null,sequence=0,boot=null;
const pending=new Map();
let memorySaved=null;
export function savedGameId() { return readSaved()?.id || null; }
function readSaved() {
  try { return JSON.parse(sessionStorage.getItem('chess-bot-local-game') || 'null'); }
  catch { return memorySaved; }
}
function save(data) {
  memorySaved=data;
  try {
    if (data) sessionStorage.setItem('chess-bot-local-game',JSON.stringify(data));
    else sessionStorage.removeItem('chess-bot-local-game');
  } catch { /* Games still work if this browser blocks session storage. */ }
}
function startWorker() {
  if (worker) return;
  if (!('Worker' in window) || !('WebAssembly' in window)) throw new Error('This browser needs WebAssembly and Web Workers to run Chess Bot. Try a current browser.');
  if (location.protocol==='file:') throw new Error('Open the site through GitHub Pages or a local HTTP server. Browsers cannot load the engine by double-clicking index.html.');
  worker=new Worker(new URL('./engine-worker.js',import.meta.url),{type:'module'});
  worker.onmessage=({data})=>{
    if (data.event) {
      document.dispatchEvent(new CustomEvent('engine-update',{detail:data}));return;
    }
    const task=pending.get(data.id); if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(Object.assign(new Error(data.error),{status:data.status}));
    else task.resolve(data.result);
  };
  worker.onerror=()=>{
    for (const task of pending.values()) task.reject(new Error('The browser engine could not start. Check that all files in Webpage were uploaded, then try again.'));
    pending.clear();worker.terminate();worker=null;boot=null;
  };
}
function request(data) {
  startWorker();
  return new Promise((resolve,reject)=>{
    const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({...data,id});
  });
}
async function initialize() {
  if (!boot) boot=(async()=>{
    const catalog=await request({command:'models'}),saved=readSaved();
    if (saved) {
      try { await request({command:'restore',saved}); }
      catch {save(null);}
    }
    return catalog;
  })().catch(error=>{
    // Runtime initialization can retain a failed WASM backend. A fresh worker
    // makes Retry recover after a temporarily unavailable static asset.
    worker?.terminate();worker=null;boot=null;throw error;
  });
  return boot;
}
// The existing board interface calls this in-process bridge. No game API exists
// on the host; only static JavaScript, WASM and model downloads use the network.
export async function localAPI(route,data,method=data?'POST':'GET') {
  const catalog=await initialize();
  if (route==='/models') return catalog;
  let result;
  if (route==='/games' && method==='POST') result=await request({command:'new',...data});
  else {
    const match=route.match(/^\/games\/([^/]+)(?:\/(move|reply|undo|resign))?$/);
    if (!match) throw new Error('Unknown local game action.');
    result=await request({command:method==='DELETE'?'delete':match[2] || 'get',game:match[1],...data});
  }
  if (result.portable) save(result.portable);
  if (result.deleted) save(null);
  return result;
}
export function stopThinking() { worker?.postMessage({command:'cancel'}); }
