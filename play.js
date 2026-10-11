import {localAPI, savedGameId, stopThinking} from './local-engine.js';
import {START_FEN, NAMES, parsePosition, pieceAsset, squareOrder, moveSquares} from './view.js';
import {squareName, gamePGN} from './play-view.js';
import {revealInList, followsLatest} from './live-view.js';

const $ = id => document.getElementById(id);
const board = $('play-board');
let game = null, catalog = null, busy = false, flipped = false, selected = null, viewPly = 0;
let renderedFlip = null, renderedMoveKey = null, resultShown = '', keyboardMove = false;
let drag = null, ignoreClick = false, promotionResolve = null;
const cells = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const api = localAPI;

function showError(error) {
  $('error-message').textContent = error.message; $('play-error').hidden = false;
  $('retry').textContent = game && game.result === '*' && game.turn !== game.human ? 'Retry model move' : 'Try again';
}

function isLive() { return !game || viewPly === game.moves.length; }
function canMove() { return game && !busy && isLive() && game.result === '*' && game.turn === game.human; }

function createBoard() {
  if (renderedFlip === flipped) return;
  renderedFlip = flipped; cells.clear();
  const fragment = document.createDocumentFragment();
  squareOrder(flipped).forEach((index, position) => {
    const cell = document.createElement('button'), name = squareName(index);
    cell.className = 'play-square' + ((Math.floor(index / 8) + index % 8) % 2 === 0 ? ' dark' : '');
    cell.dataset.square = name; cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-rowindex', String(Math.floor(position / 8) + 1)); cell.setAttribute('aria-colindex', String(position % 8 + 1));
    cell.tabIndex = position === 56 ? 0 : -1;
    if (position % 8 === 0) {
      const rank = document.createElement('span'); rank.className = 'coordinate rank'; rank.textContent = name[1]; cell.append(rank);
    }
    if (position >= 56) {
      const file = document.createElement('span'); file.className = 'coordinate file'; file.textContent = name[0]; cell.append(file);
    }
    const piece = document.createElement('img'); piece.className = 'piece'; piece.alt = ''; piece.draggable = false; piece.hidden = true; cell.append(piece);
    cells.set(name, cell); fragment.append(cell);
  });
  board.replaceChildren(fragment);
}

function renderBoard(animateMove = null) {
  createBoard();
  const position = parsePosition(game ? game.fens[viewPly] : START_FEN);
  const last = game && viewPly ? game.moves[viewPly - 1].uci : null;
  const highlighted = moveSquares(last).map(squareName);
  const targets = selected && canMove() ? game.legal_moves.filter(move => move.startsWith(selected)).map(move => move.slice(2, 4)) : [];
  for (let index = 0; index < 64; index++) {
    const name = squareName(index), cell = cells.get(name), symbol = position.squares[index], piece = cell.querySelector('.piece');
    const color = symbol && symbol === symbol.toUpperCase() ? 'white' : 'black';
    piece.hidden = !symbol; if (symbol) piece.src = pieceAsset(symbol);
    cell.classList.toggle('last-move', highlighted.includes(name)); cell.classList.toggle('selected', name === selected);
    cell.classList.toggle('legal-target', targets.includes(name) && !symbol); cell.classList.toggle('legal-capture', targets.includes(name) && Boolean(symbol));
    cell.classList.toggle('in-check', Boolean(game?.in_check && isLive() && symbol.toLowerCase() === 'k' && color === game.turn));
    cell.setAttribute('aria-label', `${name}, ${symbol ? color + ' ' + NAMES[symbol.toLowerCase()] : 'empty'}${targets.includes(name) ? ', legal destination' : ''}`);
    cell.setAttribute('aria-selected', String(name === selected));
  }
  if (animateMove && !reducedMotion.matches && !keyboardMove && isLive()) {
    const source = cells.get(animateMove.slice(0, 2)), target = cells.get(animateMove.slice(2, 4));
    if (source && target) {
      const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
      target.querySelector('.piece').animate([{transform: `translate(${from.x - to.x}px, ${from.y - to.y}px)`}, {transform: 'translate(0, 0)'}], {duration: 150, easing: 'cubic-bezier(.23,1,.32,1)'});
    }
  }
  $('board-notice').hidden = !game || isLive(); $('board-notice-text').textContent = `Viewing move ${Math.ceil(viewPly / 2) || 0}`;
}

function renderMoves() {
  const key = game ? `${game.id}:${game.revision}` : '';
  if (key !== renderedMoveKey) {
    renderedMoveKey = key;
    const fragment = document.createDocumentFragment();
    if (game?.moves.length) {
      for (let index = 0; index < game.moves.length; index += 2) {
        const row = document.createElement('div'); row.className = 'move-row';
        const number = document.createElement('span'); number.className = 'move-number'; number.textContent = `${index / 2 + 1}.`; row.append(number);
        for (let ply = index; ply < Math.min(index + 2, game.moves.length); ply++) {
          const button = document.createElement('button'); button.className = 'move-button'; button.textContent = game.moves[ply].san;
          button.dataset.ply = String(ply + 1); button.setAttribute('aria-label', `Move ${Math.floor(ply / 2) + 1}, ${game.moves[ply].color}: ${game.moves[ply].san}`); row.append(button);
        }
        fragment.append(row);
      }
      $('move-list').replaceChildren(fragment);
    } else {
      const empty = document.createElement('div'); empty.className = 'empty-moves';
      const text = document.createElement('p'); text.textContent = game?.human === 'black' ? 'The model makes the first move.' : 'The first move is yours.';
      empty.append(text); $('move-list').replaceChildren(empty);
    }
  }
  for (const button of $('move-list').querySelectorAll('[data-ply]')) {
    const current = Number(button.dataset.ply) === viewPly; button.classList.toggle('current', current);
    if (current) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  }
  $('move-counter').textContent = game?.moves.length || 0; $('history-position').textContent = `${viewPly} / ${game?.moves.length || 0}`;
  $('first-move').disabled = $('previous-move').disabled = viewPly === 0;
  $('last-move').disabled = $('next-move').disabled = !game || isLive();
}

const reasonText = {checkmate: 'Checkmate', stalemate: 'Stalemate', threefold_repetition: 'Threefold repetition', fifty_move_rule: 'Fifty-move rule', insufficient_material: 'Insufficient material', resignation: 'Resignation'};
function renderStatus() {
  const active = game?.result === '*', thinking = active && game.turn !== game.human;
  $('game-status').textContent = !game ? (busy ? 'Preparing your game…' : 'Start a game to play') : !active ? reasonText[game.reason] || 'Game over' : thinking ? 'Thinking…' : busy ? 'Updating…' : game.in_check ? 'You’re in check' : 'Your turn';
  $('game-search').textContent = game?.search ? `${game.search.seconds.toFixed(2)}s` : '';
  $('take-back').disabled = busy || !game?.can_undo;
  $('resign-game').disabled = busy || !active;
  $('download-pgn').disabled = !game?.moves.length;
  $('start-game').disabled = busy || !catalog?.models.length;
  $('start-game').querySelector('span').textContent = busy && !game ? 'Loading…' : game ? 'New game' : 'Play';
  $('stop-engine').disabled = !busy || !thinking;
  board.setAttribute('aria-busy', String(busy));
}
function render(animateMove = null) { renderBoard(animateMove); renderMoves(); renderStatus(); }

function applyGame(next, forceLive = false) {
  const follow = forceLive || followsLatest($('move-list')), scroll = $('move-list').scrollTop;
  const live = forceLive || isLive(), previousLength = game?.moves.length || 0;
  game = next; selected = null; viewPly = live ? game.moves.length : Math.min(viewPly, game.moves.length);

  render(game.moves.length > previousLength ? game.moves.at(-1).uci : null);
  if (isLive()) $('move-list').scrollTop = follow ? $('move-list').scrollHeight : scroll;
  if (game.result !== '*' && resultShown !== `${game.id}:${game.revision}`) {
    resultShown = `${game.id}:${game.revision}`;
    const winner = game.result === '1-0' ? 'white' : game.result === '0-1' ? 'black' : null;
    $('result-title').textContent = !winner ? 'A draw.' : winner === game.human ? 'You win!' : 'Chess Bot wins';
    $('result-description').textContent = `${reasonText[game.reason] || 'Game over'} · ${game.result}`; $('result-piece').src = pieceAsset(winner === 'black' ? 'k' : 'K');
    if (!$('result-dialog').open) $('result-dialog').showModal();
  }
}

async function action(callback) {
  if (busy) return;
  busy = true; selected = null; $('play-error').hidden = true; render();
  try { await callback(); }
  catch (error) {
    // Refresh the worker's committed position before retrying a failed action.
    if (game) {
      try { applyGame(await api(`/games/${game.id}`)); }
      catch (refreshError) { if (refreshError.status === 404) { game = null;  viewPly = 0; } }
    }
    showError(error);
  } finally { busy = false; keyboardMove = false; render(); }
}
async function reply() {
  if (game?.result === '*' && game.turn !== game.human) {
    renderStatus(); applyGame(await api(`/games/${game.id}/reply`, {revision: game.revision}));
  }
}
async function startGame() {
  await action(async () => {
    const previous = game?.id;
    if (previous) {
      try { await api(`/games/${previous}`, {}, 'DELETE'); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    game = null; viewPly = 0;  render();
    const next = await api('/games', {model: document.querySelector('input[name=model]:checked').value, color: document.querySelector('input[name=side]:checked').value, simulations: Number(document.querySelector('input[name=search]:checked').value)});
    flipped = next.human === 'black'; applyGame(next, true); await reply();
  });
}

async function choosePromotion(moves) {
  const options = $('promotion-options'); options.replaceChildren();
  for (const kind of ['q', 'r', 'b', 'n']) {
    const move = moves.find(text => text.endsWith(kind)); if (!move) continue;
    const button = document.createElement('button'), image = document.createElement('img'), label = document.createElement('span');
    image.src = pieceAsset(game.human === 'white' ? kind.toUpperCase() : kind); image.alt = ''; label.textContent = NAMES[kind][0].toUpperCase() + NAMES[kind].slice(1);
    button.append(image, label); button.setAttribute('aria-label', `Promote to ${NAMES[kind]}`);
    button.addEventListener('click', () => { $('promotion-dialog').close(); promotionResolve(move); promotionResolve = null; }); options.append(button);
  }
  $('promotion-dialog').showModal(); return new Promise(resolve => { promotionResolve = resolve; });
}
async function tryMove(source, target) {
  if (!canMove()) return;
  const legal = game.legal_moves.filter(move => move.startsWith(source + target)); if (!legal.length) return;
  const move = legal.length > 1 ? await choosePromotion(legal) : legal[0]; if (!move || !canMove()) return;
  await action(async () => { applyGame(await api(`/games/${game.id}/move`, {move, revision: game.revision}), true); await reply(); });
}
function selectSquare(name) {
  if (!canMove()) return;
  if (selected && name !== selected && game.legal_moves.some(move => move.startsWith(selected + name))) { void tryMove(selected, name); return; }
  selected = name === selected ? null : game.legal_moves.some(move => move.startsWith(name)) ? name : null; renderBoard();
}

board.addEventListener('click', event => {
  if (ignoreClick) { ignoreClick = false; return; }
  const square = event.target.closest('[data-square]'); if (square) { keyboardMove = event.detail === 0; selectSquare(square.dataset.square); }
});
board.addEventListener('keydown', event => {
  const items = [...board.children], index = items.indexOf(document.activeElement), steps = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8};
  if (event.key in steps && index >= 0) {
    event.preventDefault(); event.stopPropagation(); const next = Math.min(63, Math.max(0, index + steps[event.key]));
    items[index].tabIndex = -1; items[next].tabIndex = 0; items[next].focus();
  } else if (event.key === 'Escape') { selected = null; renderBoard(); }
});
board.addEventListener('focusin', event => { if (event.target.matches('[data-square]')) for (const cell of cells.values()) cell.tabIndex = cell === event.target ? 0 : -1; });
board.addEventListener('pointerdown', event => {
  if (!canMove() || drag || event.button !== 0 || !event.isPrimary) return;
  const cell = event.target.closest('[data-square]'); if (!cell || !game.legal_moves.some(move => move.startsWith(cell.dataset.square))) return;
  drag = {source: cell.dataset.square, x: event.clientX, y: event.clientY, pointer: event.pointerId, ghost: null, cell}; cell.setPointerCapture(event.pointerId);
});
board.addEventListener('pointermove', event => {
  if (!drag || drag.pointer !== event.pointerId) return;
  if (!drag.ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) {
    drag.ghost = drag.cell.querySelector('.piece').cloneNode(); drag.ghost.className = 'drag-ghost'; const size = drag.cell.getBoundingClientRect().width;
    drag.ghost.style.width = drag.ghost.style.height = size + 'px'; document.body.append(drag.ghost); drag.cell.classList.add('drag-source');
    selected = drag.source; renderBoard();
  }
  if (drag.ghost) { event.preventDefault(); drag.ghost.style.left = event.clientX - drag.ghost.width / 2 + 'px'; drag.ghost.style.top = event.clientY - drag.ghost.height / 2 + 'px'; }
});
function clearDrag() {
  if (!drag) return;
  const current = drag; drag = null; current.ghost?.remove(); current.cell.classList.remove('drag-source');
  if (current.cell.hasPointerCapture(current.pointer)) current.cell.releasePointerCapture(current.pointer);
}
board.addEventListener('pointerup', event => {
  if (!drag || drag.pointer !== event.pointerId) return;
  if (drag.ghost) {
    const source = drag.source, target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-square]')?.dataset.square;
    ignoreClick = true; setTimeout(() => { ignoreClick = false; }, 0); clearDrag(); if (target) void tryMove(source, target);
  } else clearDrag();
});
board.addEventListener('pointercancel', clearDrag); board.addEventListener('lostpointercapture', clearDrag);

function review(ply) {
  if (!game) return;
  selected = null; viewPly = Math.max(0, Math.min(game.moves.length, ply)); render(); revealInList($('move-list'), $('move-list').querySelector('.current'));
}
$('move-list').addEventListener('click', event => { const move = event.target.closest('[data-ply]'); if (move) review(Number(move.dataset.ply)); });
$('first-move').addEventListener('click', () => review(0)); $('previous-move').addEventListener('click', () => review(viewPly - 1));
$('next-move').addEventListener('click', () => review(viewPly + 1)); $('last-move').addEventListener('click', () => review(game?.moves.length || 0));
$('return-live').addEventListener('click', () => review(game?.moves.length || 0));
$('flip-board').addEventListener('click', () => { clearDrag(); flipped = !flipped; renderBoard(); });
$('start-game').addEventListener('click', startGame);
$('take-back').addEventListener('click', () => action(async () => applyGame(await api(`/games/${game.id}/undo`, {revision: game.revision}), true)));
$('resign-game').addEventListener('click', () => $('resign-dialog').showModal()); $('cancel-resign').addEventListener('click', () => $('resign-dialog').close());
$('confirm-resign').addEventListener('click', () => { $('resign-dialog').close(); void action(async () => applyGame(await api(`/games/${game.id}/resign`, {revision: game.revision}), true)); });
function cancelPromotion() { $('promotion-dialog').close(); promotionResolve?.(null); promotionResolve = null; }
$('cancel-promotion').addEventListener('click', cancelPromotion); $('promotion-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelPromotion(); });
$('review-game').addEventListener('click', () => { $('result-dialog').close(); });
$('play-again').addEventListener('click', () => { $('result-dialog').close(); $('start-game').focus(); });
$('download-pgn').addEventListener('click', () => {
  if (!game) return;
  const link = document.createElement('a'), blob = new Blob([gamePGN(game)], {type: 'application/x-chess-pgn'});
  link.href = URL.createObjectURL(blob); link.download = `selfplay-${game.model.iteration}-${game.id.slice(0, 6)}.pgn`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
$('retry').addEventListener('click', () => action(async () => { await loadModels(); if (game) { applyGame(await api(`/games/${game.id}`)); await reply(); } }));
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.matches('input,select') || document.querySelector('dialog[open]')) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); flipped = !flipped; renderBoard(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); review(viewPly - 1); } if (event.key === 'ArrowRight') { event.preventDefault(); review(viewPly + 1); }
});

async function loadModels() {
  const previousModels = JSON.stringify(catalog?.models);
  catalog = await api('/models');
  if (previousModels === JSON.stringify(catalog.models)) { renderStatus(); return; }
  const selectedModel = document.querySelector('input[name=model]:checked')?.value;
  const fragment = document.createDocumentFragment();
  const chosen = catalog.models.some(model => model.id === selectedModel) ? selectedModel : catalog.default;
  for (const model of catalog.models) {
    const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
    label.className = 'plain-choice'; input.type = 'radio'; input.name = 'model'; input.value = model.id;
    input.checked = model.id === chosen; text.textContent = model.label; label.append(input, text); fragment.append(label);
  }
  $('model-options').replaceChildren(fragment);
  renderStatus();
}

render();
void action(async () => {
  await loadModels(); const saved = savedGameId();
  if (saved) {
    try { const restored = await api(`/games/${saved}`); flipped = restored.human === 'black'; applyGame(restored, true); await reply(); }
    catch (error) { if (error.status !== 404) throw error; }
  }
});


$('stop-engine').addEventListener('click', () => { stopThinking(); $('stop-engine').disabled = true; });
document.addEventListener('engine-update', ({detail}) => {
  if (detail.event === 'status') $('engine-status').textContent = detail.text;
  if (detail.event === 'progress' && busy) $('game-status').textContent = `Thinking… ${detail.done.toLocaleString()} / ${detail.total.toLocaleString()}`;
});
