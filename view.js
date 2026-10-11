export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const NAMES = {k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn'};
export function pieceAsset(symbol) {
  const name = NAMES[symbol?.toLowerCase()];
  return name ? `./assets/pieces/${symbol === symbol.toUpperCase() ? 'white' : 'black'}-${name}.svg` : null;
}
export function parsePosition(fen) {
  const [placement, turn, , , , number] = fen.split(' ');
  const squares = Array(64).fill('');
  placement.split('/').forEach((row, index) => {
    let file = 0;
    for (const char of row) {
      if (/[1-8]/.test(char)) file += Number(char);
      else squares[(7 - index) * 8 + file++] = char;
    }
  });
  return {squares, turn, number: Number(number)};
}
export function squareOrder(flipped) {
  const order = [];
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) order.push((flipped ? row : 7 - row) * 8 + (flipped ? 7 - column : column));
  return order;
}
export function replayPosition(game, requested) {
  const index = Math.max(0, Math.min(game.fens.length - 1, Number(requested) || 0));
  return {index, fen: game.fens[index], lastMove: index ? game.moves[index - 1] : null};
}
export function moveSquares(move) {
  if (!move) return [];
  return [move.slice(0, 2), move.slice(2, 4)].map(s => s.charCodeAt(0) - 97 + (Number(s[1]) - 1) * 8);
}
