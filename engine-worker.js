import * as ort from './vendor/ort.wasm.min.mjs';
import {Position,encode,search,uci} from './engine-core.js';

// GitHub Pages does not supply cross-origin isolation headers. Run one WASM
// thread inside our own worker so the UI stays responsive without those headers.
ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
const sessions=new Map();
let manifest=null,game=null,cancelled=false;
const status=text=>postMessage({event:'status',text});

async function catalog() {
  if (!manifest) {
    const response=await fetch(new URL('./models/manifest.json',import.meta.url));
    if (!response.ok) throw new Error('The bundled model manifest could not be loaded.');
    manifest=await response.json();
  }
  return manifest;
}
async function engine(id) {
  const model=(await catalog()).models.find(m=>m.id===id);
  if (!model) throw new Error('Choose one of the bundled models.');
  if (!sessions.has(id)) {
    status(`Loading ${model.label.toLowerCase()} model on your device…`);
    const session=await ort.InferenceSession.create(new URL(model.file,import.meta.url).href,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    sessions.set(id,session);
  }
  status(`${model.label} · iteration ${model.iteration.toLocaleString()} · ready on your device`);
  return {model,session:sessions.get(id)};
}
function push(move) {
  const played=game.position.push(move);
  game.moves.push({uci:uci(played),san:played.san,color:played.color==='w'?'white':'black'});
  game.revision++;
}
function snapshot() {
  const moves=game.position.chess.moves({verbose:true});
  const turn=game.position.chess.turn()==='w'?'white':'black';
  const outcome=game.resigned?{value:-1,reason:'resignation'}:game.position.outcome(moves);
  let result='*';
  if (outcome) result=outcome.value===0?'1/2-1/2':(game.resigned?game.human:turn)==='white'?'0-1':'1-0';
  return {id:game.id,revision:game.revision,fen:game.position.fens.at(-1),fens:game.position.fens.slice(),
    human:game.human,turn,legal_moves:outcome?[]:moves.map(uci),in_check:game.position.chess.isCheck(),
    moves:game.moves.slice(),result,reason:outcome?.reason || null,model:game.model,simulations:game.simulations,
    can_undo:game.moves.length>(game.human==='black'?1:0),search:game.search,
    portable:{id:game.id,model:game.model.id,human:game.human,simulations:game.simulations,moves:game.moves.map(m=>m.uci),resigned:game.resigned,revision:game.revision,search:game.search}};
}
function validate(request) {
  if (!game || request.game!==game.id) throw Object.assign(new Error('This game is no longer available.'),{status:404});
  if (request.revision!==undefined && request.revision!==game.revision) throw new Error('The position changed. Try again.');
}
async function create(data,restore=false) {
  const {model}=await engine(data.model);
  const budgets=[32,64,128,256,512,1024,2048];
  const human=restore?data.human:data.color==='random'?(Math.random()<0.5?'white':'black'):data.color;
  if (!['white','black'].includes(human) || !budgets.includes(data.simulations)) throw new Error('Invalid game settings.');
  game={id:restore?data.id:crypto.randomUUID(),human,model,simulations:data.simulations,position:new Position(),moves:[],revision:0,resigned:false,search:null};
  if (restore) {
    if (!Array.isArray(data.moves) || data.moves.length>2048) throw new Error('The saved game is invalid.');
    for (const move of data.moves) push(move);
    game.resigned=Boolean(data.resigned);game.revision=data.revision;game.search=data.search;
  }
  return snapshot();
}
async function dispatch(request) {
  if (request.command==='models') {
    const data=await catalog(); await engine(data.default);
    return {models:data.models,default:data.default};
  }
  if (request.command==='new') return create(request);
  if (request.command==='restore') return create(request.saved,true);
  validate(request);
  if (request.command==='get') return snapshot();
  if (request.command==='delete') {game=null;return {deleted:true};}
  if (request.command==='move') {
    const current=snapshot();
    if (current.result!=='*' || current.turn!==game.human) throw new Error('It is not your turn.');
    if (!current.legal_moves.includes(request.move)) throw new Error('Choose a legal move.');
    push(request.move); return snapshot();
  }
  if (request.command==='reply') {
    const current=snapshot();
    if (current.result!=='*') return current;
    if (current.turn===game.human) throw new Error('It is your turn.');
    cancelled=false;
    const {model,session}=await engine(game.model.id);
    const evaluate=async position=>{
      const input=new ort.Tensor('float32',encode(position,model.history_length),[1,model.history_length*14+8,8,8]);
      const output=await session.run({position:input});
      try { return {policy:Float32Array.from(output.policy.data),value:Number(output.value.data[0])}; }
      finally { input.dispose();output.policy.dispose();output.value.dispose(); }
    };
    game.search=await search(game.position,evaluate,game.simulations,model.cpuct,
      (done,total)=>postMessage({event:'progress',done,total}),()=>cancelled);
    push(game.search.move);return snapshot();
  }
  if (request.command==='undo') {
    if (!snapshot().can_undo) throw new Error('There are no moves to take back.');
    const keep=game.moves.slice();keep.pop();
    if ((keep.length%2===0?'white':'black')!==game.human && keep.length) keep.pop();
    const revision=game.revision+1;
    game.position=new Position();game.moves=[];
    for (const move of keep) push(move.uci);
    game.revision=revision;game.resigned=false;game.search=null;return snapshot();
  }
  if (request.command==='resign') {game.resigned=true;game.revision++;return snapshot();}
  throw new Error('Unknown local engine command.');
}
let queue=Promise.resolve();
self.onmessage=({data})=>{
  if (data.command==='cancel') {cancelled=true;return;}
  queue=queue.then(async()=>{
    try {postMessage({id:data.id,result:await dispatch(data)});}
    catch(error) {postMessage({id:data.id,error:error.message || 'The local engine failed.',status:error.status});}
  });
};
