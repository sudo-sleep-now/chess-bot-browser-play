/** Reveal a row in its own list without scrolling the document or other panels. */
export function revealInList(list, row) {
  if (!row) return;
  const bounds = list.getBoundingClientRect(), item = row.getBoundingClientRect();
  const top = bounds.top + list.clientTop, bottom = top + list.clientHeight;
  if (item.top < top) list.scrollTop += item.top - top;
  else if (item.bottom > bottom) list.scrollTop += item.bottom - bottom;
}

export function followsLatest(list) {
  return list.scrollHeight - list.clientHeight - list.scrollTop <= 24;
}
