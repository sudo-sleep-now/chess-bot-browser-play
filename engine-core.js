import {Chess} from './vendor/chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const directions = [[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1]];
const knights = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
const pieceTypes = 'pnbrqk';
export const squareIndex = s => s.charCodeAt(0) - 97 + (Number(s[1]) - 1) * 8;
export const uci = move => move.from + move.to + (move.promotion || '');
export const moveObject = text => ({from: text.slice(0,2), to: text.slice(2,4), ...(text[4] ? {promotion:text[4]} : {})});

function positionKey(chess) { return chess.fen().split(' ').slice(0,4).join(' '); }

// Keep the actual observation history and repetition counts, including in search.
export class Position {
  constructor(fen = START_FEN) {
    this.chess = new Chess(fen);
    this.fens = [this.chess.fen({forceEnpassantSquare:true})];
    this.counts = new Map([[positionKey(this.chess),1]]);
    this.repetitions = [1];
  }
  push(move) {
    const played = this.chess.move(typeof move === 'string' ? moveObject(move) : move);
    const key = positionKey(this.chess), count = (this.counts.get(key) || 0) + 1;
    this.counts.set(key,count);
    this.fens.push(this.chess.fen({forceEnpassantSquare:true}));
    this.repetitions.push(count);
    return played;
  }
  clone() {
    const clone = Object.create(Position.prototype);
    clone.chess = new Chess(this.fens.at(-1));
    clone.fens = this.fens.slice();
    clone.counts = new Map(this.counts);
    clone.repetitions = this.repetitions.slice();
    return clone;
  }
  outcome(moves = this.chess.moves({verbose:true})) {
    if (!moves.length) return this.chess.isCheck() ? {value:-1,reason:'checkmate'} : {value:0,reason:'stalemate'};
    if (this.repetitions.at(-1) >= 3) return {value:0,reason:'threefold_repetition'};
    if (Number(this.fens.at(-1).split(' ')[4]) >= 100) return {value:0,reason:'fifty_move_rule'};
    if (this.chess.isInsufficientMaterial()) return {value:0,reason:'insufficient_material'};
    return null;
  }
}

// Exact training layout: absolute a1=0 coordinates, 14 planes per history entry,
// then side, KQkq rights, en passant, halfmove clock and fullmove number.
export function encode(position, historyLength) {
  const data = new Float32Array((historyLength * 14 + 8) * 64);
  for (let age=0; age<Math.min(historyLength,position.fens.length); age++) {
    const index = position.fens.length-1-age, placement = position.fens[index].split(' ')[0];
    placement.split('/').forEach((row,r) => {
      let file=0;
      for (const c of row) {
        if (c >= '1' && c <= '8') file += Number(c);
        else {
          const plane=age*14 + (c===c.toUpperCase()?0:6) + pieceTypes.indexOf(c.toLowerCase());
          data[plane*64 + (7-r)*8 + file++] = 1;
        }
      }
    });
    for (let repeat=2; repeat<=3; repeat++) if (position.repetitions[index]>=repeat)
      data.fill(1,(age*14+10+repeat)*64,(age*14+11+repeat)*64);
  }
  const [,turn,rights,ep,half,full] = position.fens.at(-1).split(' '), offset = historyLength*14;
  data.fill(turn==='w'?1:0,offset*64,(offset+1)*64);
  [...'KQkq'].forEach((right,i) => data.fill(rights.includes(right)?1:0,(offset+i+1)*64,(offset+i+2)*64));
  if (ep!=='-') data[(offset+5)*64+squareIndex(ep)] = 1;
  data.fill(Math.min(Number(half),100)/100,(offset+6)*64,(offset+7)*64);
  data.fill(Math.min(Number(full),512)/512,(offset+7)*64,(offset+8)*64);
  return data;
}

export function actionIndex(move) {
  const source=squareIndex(move.from), target=squareIndex(move.to);
  const df=target%8-source%8, dr=Math.floor(target/8)-Math.floor(source/8);
  if (move.promotion && move.promotion!=='q') return source*73 + 64 + 'nbr'.indexOf(move.promotion)*3 + df+1;
  const knight=knights.findIndex(([f,r]) => f===df && r===dr);
  if (knight>=0) return source*73 + 56+knight;
  const distance=Math.max(Math.abs(df),Math.abs(dr));
  const ray=directions.findIndex(([f,r]) => f*distance===df && r*distance===dr);
  if (ray<0 || !distance) throw new Error('Invalid policy move geometry.');
  return source*73 + ray*7 + distance-1;
}

function node(move = null, prior = 1) { return {move,prior,visits:0,valueSum:0,children:null}; }
export async function search(position, evaluate, budget, cpuct=1.5, onProgress=()=>{}, cancelled=()=>false) {
  const started=performance.now(), legal=position.chess.moves({verbose:true});
  if (position.outcome(legal)) throw new Error('This game has finished.');
  const root=node();
  async function expand(current,state) {
    const moves=state.chess.moves({verbose:true}), terminal=state.outcome(moves);
    if (terminal) { current.children=[]; current.terminal=terminal.value; return terminal.value; }
    const {policy,value}=await evaluate(state);
    if (!Number.isFinite(value) || policy.some(x=>!Number.isFinite(x))) throw new Error('The model returned an invalid evaluation.');
    const logits=moves.map(m=>policy[actionIndex(m)]), max=Math.max(...logits);
    const weights=logits.map(x=>Math.exp(x-max)), sum=weights.reduce((a,b)=>a+b,0);
    current.children=moves.map((m,i)=>node(m,weights[i]/sum));
    return value;
  }
  await expand(root,position);
  // Take a proven mate immediately. Exclude moves allowing immediate mate when
  // at least one safe move exists. These rules do not replace neural evaluation.
  const safe=[];
  for (const child of root.children) {
    const probe=position.clone(); probe.push(child.move);
    const terminal=probe.outcome();
    if (terminal?.reason==='checkmate') return {move:uci(child.move),simulations:0,seconds:(performance.now()-started)/1000,assistance:'mate-in-1'};
    if (terminal) {safe.push(child);continue;}
    let unsafe=false;
    for (const reply of probe.chess.moves({verbose:true})) {
      probe.chess.move(reply); unsafe=probe.chess.isCheckmate(); probe.chess.undo();
      if (unsafe) break;
    }
    if (!unsafe) safe.push(child);
  }
  if (safe.length) {
    root.children=safe;
    const total=safe.reduce((sum,c)=>sum+c.prior,0);
    safe.forEach(c=>c.prior=total>0?c.prior/total:1/safe.length);
  }
  let completed=0;
  for (;completed<budget && !cancelled();completed++) {
    const state=position.clone(), path=[root]; let current=root;
    while (current.children?.length) {
      const exploration=cpuct*Math.sqrt(current.visits+1);
      current=current.children.reduce((best,c)=>{
        const score=(c.visits?-c.valueSum/c.visits:0)+exploration*c.prior/(c.visits+1);
        const bestScore=(best.visits?-best.valueSum/best.visits:0)+exploration*best.prior/(best.visits+1);
        return score>bestScore?c:best;
      });
      state.push(current.move); path.push(current);
    }
    let value=current.children===null?await expand(current,state):current.terminal;
    for (let i=path.length-1;i>=0;i--) { path[i].visits++; path[i].valueSum+=value; value=-value; }
    if ((completed+1)%8===0) {
      onProgress(completed+1,budget);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  const best=root.children.reduce((a,b)=> b.visits>a.visits || (b.visits===a.visits && b.prior>a.prior)?b:a);
  return {move:uci(best.move),simulations:completed,seconds:(performance.now()-started)/1000,stopped:completed<budget};
}
