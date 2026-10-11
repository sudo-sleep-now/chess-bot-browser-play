import {parsePosition} from './view.js';

export const squareName = index => String.fromCharCode(97 + index % 8) + (Math.floor(index / 8) + 1);
export const squareIndex = name => name.charCodeAt(0) - 97 + (Number(name[1]) - 1) * 8;

export function capturedPieces(game, ply = game.moves.length) {
  const captured = {white: [], black: []};
  for (let index = 0; index < ply; index++) {
    const record = game.moves[index], before = parsePosition(game.fens[index]);
    const source = squareIndex(record.uci.slice(0, 2)), target = squareIndex(record.uci.slice(2, 4));
    let piece = before.squares[target];
    if (!piece && before.squares[source].toLowerCase() === 'p' && source % 8 !== target % 8) piece = record.color === 'white' ? 'p' : 'P';
    if (piece) captured[record.color].push(piece);
  }
  return captured;
}

export function gamePGN(game, date = new Date()) {
  const escape = text => String(text).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\r\n]/g, ' ');
  const model = `Chess Bot (${game.model.label}, iteration ${game.model.iteration})`;
  const tags = {Event: 'Human vs Chess Bot', Site: 'Browser-local Chess Bot', Date: date.toISOString().slice(0, 10).replaceAll('-', '.'), Round: '-', White: game.human === 'white' ? 'You' : model, Black: game.human === 'black' ? 'You' : model, Result: game.result, TimeControl: '-'};
  const moves = [];
  for (let index = 0; index < game.moves.length; index++) {
    if (index % 2 === 0) moves.push(`${index / 2 + 1}.`);
    moves.push(game.moves[index].san);
  }
  moves.push(game.result);
  return Object.entries(tags).map(([key, value]) => `[${key} "${escape(value)}"]`).join('\n') + '\n\n' + moves.join(' ') + '\n';
}
